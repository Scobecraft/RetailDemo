package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Überträgt Kamerabild, Druckerdaten und Modell an den Retail-Demo-Server, der sie auf seiner
// Webseite (Reiter "3D-Drucker") zeigt. Der Server muss den Drucker dafür nicht erreichen können.
//
// Kamerabilder gehen nur dann flüssig raus, wenn gerade jemand auf der Webseite zuschaut
// (meldet der Server zurück) – sonst alle 30 s ein Vorschaubild, um die Leitung zu schonen.

const (
	pushStateEvery   = 2 * time.Second
	pushFrameIdle    = 30 * time.Second
	pushFrameLive    = 66 * time.Millisecond // höchstens ca. 15 Bilder/s (so viele liefert die Kamera ohnehin selten)
	pushFrameFlight  = 3                     // so viele Bilder dürfen gleichzeitig unterwegs sein (verdeckt die Laufzeit übers Internet)
	pushMaxModelSize = 90 << 20              // Cloudflare lässt höchstens 100 MB pro Anfrage durch
)

type Pusher struct {
	mu       sync.Mutex
	state    string // "off", "ok", "error"
	msg      string
	lastOK   time.Time
	watching bool
	// Zeitraffer: Server möchte während des Drucks alle frameEvery Bilder (auch ohne Zuschauer)
	timelapse  bool
	frameEvery time.Duration
}

func (p *Pusher) set(state, msg string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if state == "ok" {
		p.lastOK = time.Now()
	}
	if p.state != state || p.msg != msg {
		log.Println("Server-Übertragung:", state, msg)
	}
	p.state, p.msg = state, msg
}

func (p *Pusher) Status() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	last := ""
	if !p.lastOK.IsZero() {
		last = p.lastOK.Format(time.RFC3339)
	}
	st := p.state
	if st == "" {
		st = "off"
	}
	return map[string]any{"state": st, "message": p.msg, "lastOk": last, "watching": p.watching}
}

// serverBase normalisiert die eingegebene Adresse ("demo.example.de" -> "https://demo.example.de").
func serverBase(s string) string {
	s = strings.TrimRight(strings.TrimSpace(s), "/")
	if s != "" && !strings.Contains(s, "://") {
		s = "https://" + s
	}
	return s
}

func (a *App) isRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.running
}

func (a *App) pushLoop() {
	client := &http.Client{Timeout: 30 * time.Second}
	var lastState time.Time
	pushedRev, pushedKey := -1, ""
	for {
		c := a.config()
		base := serverBase(c.ServerURL)
		if base == "" || strings.TrimSpace(c.ServerToken) == "" {
			a.pusher.set("off", "")
			time.Sleep(2 * time.Second)
			continue
		}
		key := base + "|" + c.ServerToken
		if key != pushedKey { // anderer Server: Modell neu senden
			pushedKey, pushedRev = key, -1
		}
		post := func(path, ctype string, body io.Reader, size int64) (*http.Response, error) {
			req, err := http.NewRequest(http.MethodPost, base+path, body)
			if err != nil {
				return nil, err
			}
			req.ContentLength = size
			req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.ServerToken))
			req.Header.Set("Content-Type", ctype)
			return client.Do(req)
		}

		if time.Since(lastState) >= pushStateEvery {
			lastState = time.Now()
			watching, err := a.pushState(post, c)
			if err != nil {
				a.pusher.set("error", err.Error())
				time.Sleep(5 * time.Second)
				continue
			}
			a.pusher.mu.Lock()
			a.pusher.watching = watching
			a.pusher.mu.Unlock()
			a.pusher.set("ok", "")
		}

		a.mu.Lock()
		rev := a.modelRev
		a.mu.Unlock()
		if rev != pushedRev {
			if err := a.pushModel(post, c); err != nil {
				a.pusher.set("error", "Modell: "+err.Error())
			}
			pushedRev = rev // auch bei Fehler nicht endlos wiederholen
		}

		time.Sleep(100 * time.Millisecond)
	}
}

// frameLoop schickt Kamerabilder in einer eigenen Schleife: flüssig, solange jemand zuschaut, sonst
// selten. Mehrere Bilder dürfen gleichzeitig unterwegs sein; die Nummer im Kopf sorgt dafür, dass der
// Server ein zu spät angekommenes älteres Bild verwirft.
func (a *App) frameLoop() {
	client := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true, MaxIdleConnsPerHost: pushFrameFlight + 1,
		IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 10 * time.Second,
	}}
	session := strconv.FormatInt(time.Now().UnixNano(), 36) // neue Zählung nach jedem Start
	slots := make(chan struct{}, pushFrameFlight)
	var lastFrame time.Time
	var frameSeq uint64
	var sent uint64
	for {
		c := a.config()
		base := serverBase(c.ServerURL)
		token := strings.TrimSpace(c.ServerToken)
		if base == "" || token == "" || !a.isRunning() {
			time.Sleep(time.Second)
			continue
		}
		a.pusher.mu.Lock()
		watching, timelapse, tlEvery := a.pusher.watching, a.pusher.timelapse, a.pusher.frameEvery
		a.pusher.mu.Unlock()
		every := pushFrameIdle
		if timelapse && tlEvery > 0 {
			every = tlEvery
		}
		if watching {
			every = pushFrameLive
		}
		if wait := every - time.Since(lastFrame); wait > 0 {
			if wait > 500*time.Millisecond { // ab und zu nachsehen, ob inzwischen jemand zuschaut
				wait = 500 * time.Millisecond
			}
			time.Sleep(wait)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		frame, seq := a.stream.Wait(ctx, frameSeq, time.Second)
		cancel()
		if frame == nil || seq == frameSeq {
			continue
		}
		frameSeq, lastFrame = seq, time.Now()
		select {
		case slots <- struct{}{}:
		default:
			continue // Leitung voll: dieses Bild auslassen, das nächste ist ohnehin aktueller
		}
		sent++
		go func(frame []byte, n uint64) {
			defer func() { <-slots }()
			req, err := http.NewRequest(http.MethodPost, base+"/api/druck/frame", bytes.NewReader(frame))
			if err != nil {
				return
			}
			req.ContentLength = int64(len(frame))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "image/jpeg")
			req.Header.Set("X-Frame-Session", session)
			req.Header.Set("X-Frame-Seq", strconv.FormatUint(n, 10))
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			var r struct {
				Watching *bool `json:"watching"`
			}
			if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&r) == nil && r.Watching != nil {
				a.pusher.mu.Lock()
				a.pusher.watching = *r.Watching
				a.pusher.mu.Unlock()
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}(frame, sent)
	}
}

type postFunc func(path, ctype string, body io.Reader, size int64) (*http.Response, error)

// pushState sendet Druckerdaten, Kamerastatus und Anzeige-Texte. Antwort: schaut gerade jemand zu?
func (a *App) pushState(post postFunc, c Config) (bool, error) {
	pc, pcInfo := sysMon.Latest()
	a.pushCount++
	if a.pushCount%30 != 1 && !a.serverNeedsInfo { // Hardware ändert sich nicht: ca. jede Minute reicht
		pcInfo = nil
	}
	st := a.stream.Status()
	st["url"] = "" // interne Drucker-Adresse geht den Server nichts an
	if !a.isRunning() {
		st["state"], st["error"] = "error", "Druckmonitor ist nicht gestartet"
	}
	body, _ := json.Marshal(map[string]any{
		"config": map[string]any{
			"title": c.Title, "subtitle": c.Subtitle, "ticker": c.Ticker, "rotSpeed": c.RotSpeed,
			"modelColor": c.ModelColor, "printerKind": c.PrinterKind, "modelName": c.ModelName,
		},
		"printer":    a.printerState(),
		"status":     st,
		"pc":         pc,
		"pcInfo":     pcInfo,
		"appVersion": version,
		"shutdown":   a.shutdownStatus(),
		// kann Druckaufträge von der Webseite an den Drucker schicken (braucht Seriennummer + Prüfcode)
		"capabilities": map[string]bool{"upload": strings.TrimSpace(c.FFSerial) != "" && strings.TrimSpace(c.FFCheckCode) != ""},
	})
	resp, err := post("/api/druck/state", "application/json", bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return false, errors.New("Server nicht erreichbar")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return false, errors.New("Geräte-Token falsch")
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("Server antwortet mit %d (Server aktualisiert?)", resp.StatusCode)
	}
	var r struct {
		Watching bool           `json:"watching"`
		NeedInfo bool           `json:"needInfo"`
		Update   *UpdateInfo    `json:"update"`
		PrintJob *PrintJob      `json:"print_job"`
		Model    *ModelOverride `json:"model_override"`
		// Zeitraffer läuft: alle frame_every_s Sekunden ein Bild schicken
		Timelapse  bool          `json:"timelapse"`
		Shutdown   *ShutdownPlan `json:"shutdown_plan"`
		FrameEvery float64       `json:"frame_every_s"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&r)
	a.serverNeedsInfo = r.NeedInfo && pcInfo == nil
	a.pusher.mu.Lock()
	a.pusher.timelapse = r.Timelapse
	a.pusher.frameEvery = time.Duration(r.FrameEvery * float64(time.Second))
	a.pusher.mu.Unlock()
	if r.Update != nil && !versionLess(version, r.Update.Version) {
		r.Update = nil
	}
	a.onServerUpdate(r.Update)
	a.onPrintJob(r.PrintJob)
	a.onModelOverride(r.Model)
	a.onShutdownPlan(r.Shutdown)
	return r.Watching, nil
}

func (a *App) pushModel(post postFunc, c Config) error {
	a.mu.Lock()
	rev := a.modelRev
	a.mu.Unlock()
	q := "?rev=" + strconv.Itoa(rev) + "&name=" + url.QueryEscape(c.ModelName)
	if c.ModelFile == "" {
		resp, err := post("/api/druck/model"+q, "application/octet-stream", bytes.NewReader(nil), 0)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	path := filepath.Join(a.dir, c.ModelFile)
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, _ := f.Stat()
	if st.Size() > pushMaxModelSize {
		return errors.New("Datei zu groß für den Server (über 90 MB)")
	}
	resp, err := post("/api/druck/model"+q+"&file="+url.QueryEscape(c.ModelFile), "application/octet-stream", f, st.Size())
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Server antwortet mit %d", resp.StatusCode)
	}
	return nil
}
