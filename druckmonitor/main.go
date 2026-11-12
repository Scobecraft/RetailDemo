// Druckmonitor – Vollbild-Übersicht für 3D-Drucker:
// links die Live-Kamera des Druckers, rechts das sich drehende 3D-Modell.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

// Config wird in %APPDATA%\Druckmonitor\config.json gespeichert.
type Config struct {
	IP          string  `json:"ip"`
	Preset      string  `json:"preset"`
	URLTemplate string  `json:"urlTemplate"`
	Mode        string  `json:"mode"`      // "auto" (Stream/Bild) oder "page" (Webseite einbetten)
	ReloadSec   int     `json:"reloadSec"` // nur Modus "page"
	Monitor     int     `json:"monitor"`
	Title       string  `json:"title"`
	Subtitle    string  `json:"subtitle"`
	Ticker      string  `json:"ticker"`
	ModelName   string  `json:"modelName"`
	ModelFile   string  `json:"modelFile"`
	RotSpeed    float64 `json:"rotSpeed"`
	ModelColor  string  `json:"modelColor"`
	Fullscreen  bool    `json:"fullscreen"`
	PrinterKind string  `json:"printerKind"` // "flashforge" oder "none"
	FFSerial    string  `json:"ffSerial"`
	FFCheckCode string  `json:"ffCheckCode"`
	AutoIP      bool    `json:"autoIp"`    // Drucker-IP automatisch suchen und nachführen
	AutoModel   bool    `json:"autoModel"` // Datei des aktuellen Drucks automatisch laden
	// Daten an den Retail-Demo-Server senden (Reiter "3D-Drucker" auf der Webseite)
	ServerURL   string `json:"serverUrl"`
	ServerToken string `json:"serverToken"` // Geräte-Token des Servers (DEVICE_TOKEN)
}

func defaultConfig() Config {
	return Config{
		Preset:      "mjpg8080",
		URLTemplate: "http://{ip}:8080/?action=stream",
		Mode:        "auto",
		ReloadSec:   60,
		Title:       "3D-Druck Live",
		Subtitle:    "Aktueller Druckauftrag",
		Ticker:      "Live aus unserem 3D-Druck  •  Fragen? Sprich unser Team an!",
		RotSpeed:    0.35,
		ModelColor:  "#ff7a00",
		Fullscreen:  true,
		PrinterKind: "flashforge",
		AutoIP:      true,
		AutoModel:   true,
	}
}

// StreamURL setzt die IP in die URL-Vorlage ein.
func (c Config) StreamURL() string {
	return strings.ReplaceAll(c.URLTemplate, "{ip}", cleanHost(c.IP))
}

// cleanHost entfernt versehentlich eingegebenes "http://", Pfade und Leerzeichen.
func cleanHost(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(strings.TrimPrefix(s, "http://"), "https://")
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	return s
}

// Window wird vom Fenster-Code (Windows) bereitgestellt.
type Window interface {
	SetFullscreen(on bool, monitor int)
	Monitors() []MonitorInfo
	Quit()
}

type MonitorInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Primary bool   `json:"primary"`
}

type App struct {
	dir     string
	mu      sync.Mutex
	cfg     Config
	stream  *Stream
	printer *PrinterPoller
	win     Window
	running bool // Vollbildansicht läuft

	modelRev    int    // wird bei jedem Modellwechsel erhöht (Vollbild lädt dann neu)
	modelSource string // "" = von Hand gewählt, sonst Fundort der automatischen Suche

	pusher          Pusher
	pushCount       int  // nur von pushLoop benutzt
	serverNeedsInfo bool // Server hat noch keine Hardware-Angaben

	metaMu   sync.Mutex
	metaKey  string
	metaData FileMeta
}

// printerState: Druckerdaten (live) + Angaben aus der Slicer-Datei, wie sie die Vollbildansicht braucht.
func (a *App) printerState() map[string]any {
	a.mu.Lock()
	rev, src, mname := a.modelRev, a.modelSource, a.cfg.ModelName
	a.mu.Unlock()
	return map[string]any{"live": a.printer.Info(), "file": a.fileMeta(), "kind": a.config().PrinterKind,
		"modelRev": rev, "modelName": mname, "modelSource": src}
}

// fileMeta liest die Angaben aus der Modelldatei (zwischengespeichert).
func (a *App) fileMeta() FileMeta {
	c := a.config()
	if c.ModelFile == "" {
		return FileMeta{}
	}
	path := filepath.Join(a.dir, c.ModelFile)
	st, err := os.Stat(path)
	if err != nil {
		return FileMeta{}
	}
	key := path + st.ModTime().String() + c.ModelName
	a.metaMu.Lock()
	defer a.metaMu.Unlock()
	if key != a.metaKey {
		a.metaData = readFileMeta(path, c.ModelName)
		a.metaKey = key
	}
	return a.metaData
}

func main() {
	dir := appDir()
	app := &App{dir: dir, stream: NewStream(), printer: NewPrinterPoller()}
	app.cfg = app.loadConfig()

	f, err := os.OpenFile(filepath.Join(dir, "druckmonitor.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, f))
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal("Lokaler Server konnte nicht gestartet werden: " + err.Error())
	}
	go func() { _ = http.Serve(ln, app.routes()) }()
	base := fmt.Sprintf("http://%s/", ln.Addr().String())
	log.Println("Server:", base)

	go app.watchIP()
	go app.autoModelLoop()
	go app.pushLoop()
	runShell(app, base)
}

func appDir() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	d = filepath.Join(d, "Druckmonitor")
	_ = os.MkdirAll(d, 0o755)
	return d
}

func (a *App) loadConfig() Config {
	c := defaultConfig()
	if b, err := os.ReadFile(filepath.Join(a.dir, "config.json")); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func (a *App) saveConfig(c Config) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(filepath.Join(a.dir, "config.json"), b, 0o644)
}

func (a *App) config() Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			r.URL.Path = "/setup.html"
		case "/monitor":
			r.URL.Path = "/monitor.html"
		}
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	})

	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, a.config())
	})

	// Einstellungen übernehmen und Kamera starten
	mux.HandleFunc("/api/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", http.StatusMethodNotAllowed)
			return
		}
		a.mu.Lock()
		c := a.cfg
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			a.mu.Unlock()
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.IP = cleanHost(c.IP)
		if c.ReloadSec < 10 {
			c.ReloadSec = 10
		}
		a.mu.Unlock()
		found := ""
		if c.AutoIP {
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			res := discoverPrinters(ctx, c, true)
			cancel()
			if res.Chosen != nil {
				c.IP, found = res.Chosen.IP, res.Chosen.Source
			} else if c.IP == "" {
				http.Error(w, "Kein Drucker gefunden. Ist er eingeschaltet und im selben Netzwerk?", http.StatusNotFound)
				return
			}
		}
		a.mu.Lock()
		a.cfg = c
		a.running = true
		a.mu.Unlock()
		if err := a.saveConfig(c); err != nil {
			log.Println("Konfiguration speichern:", err)
		}
		if c.Mode == "page" {
			a.stream.Stop()
		} else {
			a.stream.Start(c.StreamURL())
		}
		a.printer.Start(c)
		writeJSON(w, map[string]any{"ok": true, "url": c.StreamURL(), "ip": c.IP, "found": found})
	})

	// Drucker suchen (Einstellungsdialog). ?full=1: alle Quellen durchsuchen
	mux.HandleFunc("/api/discover", func(w http.ResponseWriter, r *http.Request) {
		c := a.config()
		if s := r.URL.Query().Get("serial"); s != "" || r.URL.Query().Has("serial") {
			c.FFSerial = s
		}
		if t := r.URL.Query().Get("template"); t != "" {
			c.URLTemplate = t
		}
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		writeJSON(w, discoverPrinters(ctx, c, r.URL.Query().Get("full") != "1"))
	})

	mux.HandleFunc("/api/stop", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		a.running = false
		a.mu.Unlock()
		a.stream.Stop()
		a.printer.Stop()
		writeJSON(w, map[string]any{"ok": true})
	})

	// Modell hochladen (Rohdaten im Body) bzw. abrufen
	mux.HandleFunc("/api/model", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			name := filepath.Base(r.URL.Query().Get("name"))
			if err := a.storeModel(name, r.Body, ""); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeJSON(w, map[string]any{"ok": true, "name": name, "meta": a.fileMeta()})
		case http.MethodDelete:
			a.mu.Lock()
			if a.cfg.ModelFile != "" {
				os.Remove(filepath.Join(a.dir, a.cfg.ModelFile))
			}
			a.cfg.ModelFile, a.cfg.ModelName = "", ""
			a.modelRev++
			c := a.cfg
			a.mu.Unlock()
			_ = a.saveConfig(c)
			writeJSON(w, map[string]any{"ok": true})
		default:
			c := a.config()
			if c.ModelFile == "" {
				http.Error(w, "kein Modell", http.StatusNotFound)
				return
			}
			w.Header().Set("X-Model-Name", url.PathEscape(c.ModelName))
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, filepath.Join(a.dir, c.ModelFile))
		}
	})

	// Neuestes Kamerabild – wartet bis zu 3 s auf ein Bild, das neuer als ?after ist
	mux.HandleFunc("/api/frame", func(w http.ResponseWriter, r *http.Request) {
		after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		frame, seq := a.stream.Wait(r.Context(), after, 3*time.Second)
		w.Header().Set("Cache-Control", "no-store")
		if frame == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("X-Seq", strconv.FormatUint(seq, 10))
		_, _ = w.Write(frame)
	})

	// Druckerdaten (live) + Angaben aus der Slicer-Datei
	mux.HandleFunc("/api/printer", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, a.printerState())
	})

	// Übertragung an den Retail-Demo-Server (Einstellungsseite)
	mux.HandleFunc("/api/push/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, a.pusher.Status())
	})

	// Druckerdaten einmalig abfragen (Einstellungsdialog)
	mux.HandleFunc("/api/printer/test", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		host := cleanHost(q.Get("ip"))
		var info PrinterInfo
		var err error
		if q.Get("serial") != "" && q.Get("code") != "" {
			info, err = ffHTTPDetail(r.Context(), host, q.Get("serial"), q.Get("code"))
		} else {
			info, err = NewPrinterPoller().pollTCP(r.Context(), host)
		}
		if err != nil {
			writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "info": info})
	})

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, a.stream.Status())
	})

	// Verbindung testen (für den Einstellungsdialog)
	mux.HandleFunc("/api/test", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, probeURL(r.URL.Query().Get("url"), true))
	})

	// Netzwerk nach dem Drucker durchsuchen
	mux.HandleFunc("/api/scan", func(w http.ResponseWriter, r *http.Request) {
		tpl := r.URL.Query().Get("template")
		if tpl == "" {
			tpl = a.config().URLTemplate
		}
		writeJSON(w, scanNetwork(r.Context(), tpl))
	})

	mux.HandleFunc("/api/monitors", func(w http.ResponseWriter, r *http.Request) {
		if a.win == nil {
			writeJSON(w, []MonitorInfo{})
			return
		}
		writeJSON(w, a.win.Monitors())
	})

	mux.HandleFunc("/api/window", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if a.win != nil {
			switch {
			case q.Get("quit") == "1":
				a.stream.Stop()
				a.win.Quit()
			case q.Has("fullscreen"):
				mon, _ := strconv.Atoi(q.Get("monitor"))
				a.win.SetFullscreen(q.Get("fullscreen") == "1", mon)
			}
		}
		writeJSON(w, map[string]any{"ok": true, "native": a.win != nil})
	})

	return mux
}

func allowedModelExt(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".stl", ".3mf", ".obj", ".glb", ".gltf", ".gcode", ".gco", ".g", ".gx":
		return true
	}
	return false
}

// storeModel speichert eine Modelldatei im Programmordner und macht sie zum aktuellen Modell.
func (a *App) storeModel(name string, src io.Reader, source string) error {
	ext := strings.ToLower(filepath.Ext(name))
	if name == "." || name == "" || !allowedModelExt(name) {
		return errors.New("Dateityp wird nicht unterstützt")
	}
	if strings.HasSuffix(strings.ToLower(name), ".gcode.3mf") {
		ext = ".3mf"
	}
	file := "modell" + ext
	tmp := filepath.Join(a.dir, file+".tmp")
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.LimitReader(src, 1<<30))
	out.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	a.mu.Lock()
	old := a.cfg.ModelFile
	if old != "" && old != file {
		os.Remove(filepath.Join(a.dir, old))
	}
	_ = os.Rename(tmp, filepath.Join(a.dir, file))
	a.cfg.ModelFile, a.cfg.ModelName = file, name
	a.modelRev++
	a.modelSource = source
	c := a.cfg
	a.mu.Unlock()
	return a.saveConfig(c)
}
