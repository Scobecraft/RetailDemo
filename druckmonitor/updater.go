package main

// Programm-Updates über den Retail-Demo-Server: Auf der Webseite wird ein neuer Installer
// (Druckmonitor-Setup-x.y.z.exe) hochgeladen. Die App erfährt bei jeder Übertragung, ob es eine
// neuere Version gibt, zeigt das in den Einstellungen an und installiert auf Knopfdruck – oder
// sofort, wenn auf der Webseite "Jetzt auf dem PC aktualisieren" gedrückt wurde.
// Der Installer läuft unsichtbar (/S /UPDATE), ersetzt die Programmdatei und startet die App neu.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// version wird beim Bauen gesetzt: -ldflags "-X main.version=1.2.0"
var version = "dev"

type UpdateInfo struct {
	Version        string `json:"version"`
	Size           int64  `json:"size"`
	Sha256         string `json:"sha256"`
	URL            string `json:"url"`
	InstallRequest *int64 `json:"install_request"`
}

type Updater struct {
	mu       sync.Mutex
	avail    *UpdateInfo
	state    string // "", "checking", "downloading", "installing", "error", "current"
	msg      string
	progress float64
	checked  time.Time
}

func (u *Updater) Status() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	var avail any
	if u.avail != nil {
		avail = u.avail
	}
	checked := ""
	if !u.checked.IsZero() {
		checked = u.checked.Format(time.RFC3339)
	}
	return map[string]any{"version": version, "available": avail, "state": u.state, "message": u.msg,
		"progress": u.progress, "checked": checked, "supported": updateSupported}
}

func (u *Updater) set(state, msg string) {
	u.mu.Lock()
	u.state, u.msg = state, msg
	u.mu.Unlock()
}

func (u *Updater) busy() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state == "downloading" || u.state == "installing"
}

var verRe = regexp.MustCompile(`\d+`)
var unsafeVerRe = regexp.MustCompile(`[^0-9.]`)

func versionLess(a, b string) bool {
	pa, pb := verRe.FindAllString(a, 4), verRe.FindAllString(b, 4)
	for i := 0; i < 4; i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// onServerUpdate wird nach jeder Übertragung mit der Antwort des Servers aufgerufen.
func (a *App) onServerUpdate(info *UpdateInfo) {
	a.updater.mu.Lock()
	a.updater.avail = info
	a.updater.checked = time.Now()
	if info == nil && a.updater.state == "" {
		a.updater.state = "current"
	} else if info != nil && a.updater.state == "current" {
		a.updater.state = ""
	}
	a.updater.mu.Unlock()
	if info == nil || info.InstallRequest == nil || !updateSupported {
		return
	}
	// "Jetzt auf dem PC aktualisieren" auf der Webseite: jede Anforderung nur einmal ausführen
	a.mu.Lock()
	handled := a.cfg.HandledUpdate
	if *info.InstallRequest <= handled {
		a.mu.Unlock()
		return
	}
	a.cfg.HandledUpdate = *info.InstallRequest
	c := a.cfg
	a.mu.Unlock()
	_ = a.saveConfig(c)
	log.Println("Update auf", info.Version, "von der Webseite angefordert")
	go a.installUpdate(info)
}

// checkUpdate fragt den Server direkt (Knopf "Nach Updates suchen").
func (a *App) checkUpdate() error {
	c := a.config()
	base := serverBase(c.ServerURL)
	if base == "" || strings.TrimSpace(c.ServerToken) == "" {
		return errors.New("Server ist nicht eingerichtet (Abschnitt „Webseite“)")
	}
	a.updater.set("checking", "")
	req, _ := http.NewRequest(http.MethodGet, base+"/api/druck/update?version="+version, nil)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.ServerToken))
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		a.updater.set("error", "Server nicht erreichbar")
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		a.updater.set("error", fmt.Sprintf("Server antwortet mit %d (Server aktualisiert?)", resp.StatusCode))
		return errors.New("Serverfehler")
	}
	var r struct {
		Release *UpdateInfo `json:"release"`
		Newer   bool        `json:"newer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		a.updater.set("error", "Antwort unverständlich")
		return err
	}
	a.updater.mu.Lock()
	a.updater.checked = time.Now()
	if r.Newer && r.Release != nil && versionLess(version, r.Release.Version) {
		r.Release.InstallRequest = nil
		a.updater.avail = r.Release
		a.updater.state = ""
	} else {
		a.updater.avail = nil
		a.updater.state = "current"
	}
	a.updater.msg = ""
	a.updater.mu.Unlock()
	return nil
}

// installUpdate lädt den Installer, prüft ihn und startet ihn. Danach beendet sich die App;
// der Installer startet sie in der neuen Version wieder.
func (a *App) installUpdate(info *UpdateInfo) {
	if !updateSupported {
		a.updater.set("error", "Updates gibt es nur für die installierte Windows-Version")
		return
	}
	a.updater.mu.Lock()
	if a.updater.state == "downloading" || a.updater.state == "installing" {
		a.updater.mu.Unlock()
		return
	}
	a.updater.state, a.updater.msg, a.updater.progress = "downloading", "", 0
	a.updater.mu.Unlock()

	path, err := a.downloadInstaller(info)
	if err != nil {
		log.Println("Update herunterladen:", err)
		a.updater.set("error", err.Error())
		return
	}
	a.updater.set("installing", "")
	log.Println("Starte Installer für Version", info.Version)
	if err := launchInstaller(path); err != nil {
		log.Println("Installer starten:", err)
		a.updater.set("error", "Installer konnte nicht gestartet werden: "+err.Error())
		return
	}
	time.Sleep(500 * time.Millisecond)
	a.stream.Stop()
	if a.win != nil {
		a.win.Quit()
		time.Sleep(3 * time.Second)
	}
	os.Exit(0)
}

func (a *App) downloadInstaller(info *UpdateInfo) (string, error) {
	c := a.config()
	base := serverBase(c.ServerURL)
	if base == "" {
		return "", errors.New("Server ist nicht eingerichtet")
	}
	req, _ := http.NewRequest(http.MethodGet, base+info.URL, nil)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.ServerToken))
	resp, err := (&http.Client{Timeout: 15 * time.Minute}).Do(req)
	if err != nil {
		return "", errors.New("Server nicht erreichbar")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Download fehlgeschlagen (HTTP %d)", resp.StatusCode)
	}
	dir := filepath.Join(os.TempDir(), "Druckmonitor-Update")
	_ = os.RemoveAll(dir) // alte Installer aufräumen
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "Druckmonitor-Setup-"+unsafeVerRe.ReplaceAllString(info.Version, "")+".exe")
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	var done int64
	buf := make([]byte, 256<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				return "", werr
			}
			h.Write(buf[:n])
			done += int64(n)
			if info.Size > 0 {
				a.updater.mu.Lock()
				a.updater.progress = float64(done) / float64(info.Size)
				a.updater.mu.Unlock()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return "", errors.New("Download abgebrochen")
		}
	}
	f.Close()
	if info.Sha256 != "" && !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), info.Sha256) {
		os.Remove(path)
		return "", errors.New("Download beschädigt (Prüfsumme falsch) – bitte erneut versuchen")
	}
	return path, nil
}
