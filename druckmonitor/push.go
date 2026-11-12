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
	pushFrameLive    = 200 * time.Millisecond // höchstens ca. 5 Bilder/s
	pushMaxModelSize = 90 << 20               // Cloudflare lässt höchstens 100 MB pro Anfrage durch
)

type Pusher struct {
	mu       sync.Mutex
	state    string // "off", "ok", "error"
	msg      string
	lastOK   time.Time
	watching bool
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
	var lastState, lastFrame time.Time
	var frameSeq uint64
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

		a.pusher.mu.Lock()
		watching := a.pusher.watching
		a.pusher.mu.Unlock()
		every := pushFrameIdle
		if watching {
			every = pushFrameLive
		}
		if a.isRunning() && time.Since(lastFrame) >= every {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			frame, seq := a.stream.Wait(ctx, frameSeq, time.Second)
			cancel()
			if frame != nil && seq != frameSeq {
				frameSeq, lastFrame = seq, time.Now()
				if resp, err := post("/api/druck/frame", "image/jpeg", bytes.NewReader(frame), int64(len(frame))); err == nil {
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
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
		Watching bool        `json:"watching"`
		NeedInfo bool        `json:"needInfo"`
		Update   *UpdateInfo `json:"update"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&r)
	a.serverNeedsInfo = r.NeedInfo && pcInfo == nil
	if r.Update != nil && !versionLess(version, r.Update.Version) {
		r.Update = nil
	}
	a.onServerUpdate(r.Update)
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
