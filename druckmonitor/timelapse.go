package main

// Zeitraffer vom Server: Liste und Videos für die Vollbildansicht. Solange nicht gedruckt wird, spielt
// monitor.html die letzten Zeitraffer ab. Videos werden lokal zwischengespeichert (einmal laden).

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var tlIDRe = regexp.MustCompile(`^\d{8}-\d{6}$`)

type tlCache struct {
	mu      sync.Mutex
	list    []byte
	listAt  time.Time
	loading map[string]bool
}

var timelapses = &tlCache{loading: map[string]bool{}}

func (a *App) tlDir() string {
	d := filepath.Join(a.dir, "zeitraffer")
	_ = os.MkdirAll(d, 0o755)
	return d
}

func (a *App) serverGet(path string, timeout time.Duration) (*http.Response, error) {
	c := a.config()
	base := serverBase(c.ServerURL)
	if base == "" || strings.TrimSpace(c.ServerToken) == "" {
		return nil, os.ErrNotExist
	}
	req, err := http.NewRequest(http.MethodGet, base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.ServerToken))
	return (&http.Client{Timeout: timeout}).Do(req)
}

// handleTimelapses: GET /api/timelapses – Liste vom Server (1 Minute zwischengespeichert, offline: letzte bekannte)
func (a *App) handleTimelapses(w http.ResponseWriter, r *http.Request) {
	t := timelapses
	t.mu.Lock()
	fresh := t.list != nil && time.Since(t.listAt) < time.Minute
	cached := t.list
	t.mu.Unlock()
	if !fresh {
		if resp, err := a.serverGet("/api/druck/timelapses", 10*time.Second); err == nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK && json.Valid(b) {
				cached = b
				t.mu.Lock()
				t.list, t.listAt = b, time.Now()
				t.mu.Unlock()
				go a.tlPrefetch(b)
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if cached == nil {
		_, _ = w.Write([]byte(`{"show":false,"items":[]}`))
		return
	}
	_, _ = w.Write(cached)
}

// tlPrefetch lädt neue Videos im Hintergrund und löscht nicht mehr gelistete.
func (a *App) tlPrefetch(list []byte) {
	var l struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if json.Unmarshal(list, &l) != nil {
		return
	}
	keep := map[string]bool{}
	for _, it := range l.Items {
		if tlIDRe.MatchString(it.ID) {
			keep[it.ID+".mp4"] = true
			a.tlFetch(it.ID)
		}
	}
	if entries, err := os.ReadDir(a.tlDir()); err == nil && len(l.Items) > 0 {
		for _, e := range entries {
			if !keep[e.Name()] {
				_ = os.Remove(filepath.Join(a.tlDir(), e.Name()))
			}
		}
	}
}

func (a *App) tlFetch(id string) {
	path := filepath.Join(a.tlDir(), id+".mp4")
	if _, err := os.Stat(path); err == nil {
		return
	}
	t := timelapses
	t.mu.Lock()
	if t.loading[id] {
		t.mu.Unlock()
		return
	}
	t.loading[id] = true
	t.mu.Unlock()
	defer func() { t.mu.Lock(); delete(t.loading, id); t.mu.Unlock() }()
	resp, err := a.serverGet("/api/druck/timelapses/"+id+".mp4", 10*time.Minute)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	tmp := path + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 2<<30))
	f.Close()
	if err != nil {
		_ = os.Remove(tmp)
		return
	}
	_ = os.Rename(tmp, path)
}

// handleTimelapseFile: GET /api/timelapse/<id>.mp4 – aus dem Zwischenspeicher (mit Spulen/Range)
func (a *App) handleTimelapseFile(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/timelapse/"), ".mp4")
	if !tlIDRe.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(a.tlDir(), id+".mp4")
	if _, err := os.Stat(path); err != nil {
		a.tlFetch(id) // noch nicht da: jetzt laden
	}
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "Zeitraffer nicht verfügbar", http.StatusNotFound)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "video/mp4")
	http.ServeContent(w, r, id+".mp4", st.ModTime(), f)
}
