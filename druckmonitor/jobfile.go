package main

// Lädt automatisch die Datei, die gerade gedruckt wird.
// Der Drucker meldet den Dateinamen des aktuellen Drucks (z. B. "Gecko.3mf"). Diese Datei
// wird auf dem PC gesucht: in den Ordnern von Flash Studio, im Temp-Ordner (dort legt
// Flash Studio die geslicte Datei vor dem Senden ab) sowie in Downloads, Desktop und Dokumente.
// Geslicte Dateien (G-Code / .gcode.3mf) werden bevorzugt, weil nur sie Druckzeit,
// Filamentmenge usw. enthalten.

import (
	"archive/zip"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var modelExts = []string{".gcode.3mf", ".3mf", ".gcode", ".gco", ".gx", ".stl", ".obj"}

// normBase: "Gecko_PLA.gcode.3mf" -> "gecko_pla"
func normBase(name string) string {
	n := strings.ToLower(filepath.Base(strings.ReplaceAll(name, "\\", "/")))
	for _, e := range modelExts {
		if strings.HasSuffix(n, e) {
			return strings.TrimSpace(strings.TrimSuffix(n, e))
		}
	}
	return strings.TrimSpace(strings.TrimSuffix(n, filepath.Ext(n)))
}

// modelExtOf: ".gcode.3mf", ".stl", … (kleingeschrieben)
func modelExtOf(name string) string {
	n := strings.ToLower(filepath.Base(name))
	for _, e := range modelExts {
		if strings.HasSuffix(n, e) {
			return e
		}
	}
	return strings.ToLower(filepath.Ext(n))
}

// stem: Dateiname ohne Modell-Endung, Groß-/Kleinschreibung bleibt erhalten
func stem(name string) string {
	b := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	return b[:len(b)-len(modelExtOf(b))]
}

func hasModelExt(name string) bool {
	n := strings.ToLower(name)
	for _, e := range modelExts {
		if strings.HasSuffix(n, e) {
			return true
		}
	}
	return false
}

// isSliced: enthält die Datei Druckdaten (G-Code)?
func isSliced(path string) bool {
	n := strings.ToLower(path)
	if strings.HasSuffix(n, ".gcode") || strings.HasSuffix(n, ".gco") || strings.HasSuffix(n, ".gx") {
		return true
	}
	if !strings.HasSuffix(n, ".3mf") {
		return false
	}
	z, err := zip.OpenReader(path)
	if err != nil {
		return false
	}
	defer z.Close()
	for _, f := range z.File {
		fn := strings.ToLower(f.Name)
		if strings.HasSuffix(fn, ".gcode") || strings.HasSuffix(fn, "slice_info.config") {
			return true
		}
	}
	return false
}

type searchRoot struct {
	dir      string
	depth    int
	slicerOK bool // Ordner gehört zu Flash Studio / Temp: auch Dateien mit anderem Namen zulassen
}

func searchRoots() []searchRoot {
	var roots []searchRoot
	add := func(d string, depth int, slicer bool) {
		if d == "" {
			return
		}
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			roots = append(roots, searchRoot{d, depth, slicer})
		}
	}
	for _, base := range []string{os.Getenv("APPDATA"), os.Getenv("LOCALAPPDATA"), func() string { d, _ := os.UserConfigDir(); return d }()} {
		if base == "" {
			continue
		}
		entries, _ := os.ReadDir(base)
		for _, e := range entries {
			n := strings.ToLower(e.Name())
			if e.IsDir() && (strings.Contains(n, "flash") || strings.Contains(n, "orca")) && !strings.Contains(n, "druckmonitor") {
				add(filepath.Join(base, e.Name()), 6, true)
			}
		}
	}
	add(os.TempDir(), 6, true)
	if home, err := os.UserHomeDir(); err == nil {
		for _, d := range []string{"Downloads", "Desktop", "Documents", "Dokumente", "OneDrive/Desktop", "OneDrive/Documents", "OneDrive/Dokumente"} {
			add(filepath.Join(home, filepath.FromSlash(d)), 4, false)
		}
	}
	return roots
}

type jobCandidate struct {
	path   string
	mod    time.Time
	exact  bool
	sliced bool
}

// findPrintFile sucht die Datei zum gemeldeten Druckauftrag. Rückgabe: Pfad und Fundart.
func findPrintFile(job string, since time.Time) (string, string) {
	want := normBase(job)
	if want == "" {
		return "", ""
	}
	var best *jobCandidate
	better := func(c jobCandidate) bool {
		if best == nil {
			return true
		}
		if c.exact != best.exact {
			return c.exact
		}
		if c.sliced != best.sliced {
			return c.sliced
		}
		return c.mod.After(best.mod)
	}
	visited := 0
	skip := map[string]bool{"node_modules": true, ".git": true, "$recycle.bin": true, "appdata": true, "webview2": true,
		"cache": true, "caches": true, "logs": true, "log": true}
	for _, root := range searchRoots() {
		rootDepth := strings.Count(root.dir, string(os.PathSeparator))
		_ = filepath.WalkDir(root.dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			visited++
			if visited > 300000 {
				return filepath.SkipAll
			}
			if d.IsDir() {
				if path != root.dir && (skip[strings.ToLower(d.Name())] || strings.Count(path, string(os.PathSeparator))-rootDepth > root.depth) {
					return filepath.SkipDir
				}
				return nil
			}
			if !hasModelExt(d.Name()) {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			c := jobCandidate{path: path, mod: info.ModTime(), exact: normBase(d.Name()) == want}
			if !c.exact {
				// Ohne Namensgleichheit nur frisch geslicte Dateien aus Flash-Studio-/Temp-Ordnern
				pl := strings.ToLower(path)
				if !root.slicerOK || info.ModTime().Before(since) ||
					!(strings.Contains(pl, "orca") || strings.Contains(pl, "flash") || strings.Contains(pl, "bambu")) {
					return nil
				}
			}
			c.sliced = isSliced(path)
			if !c.exact && !c.sliced {
				return nil
			}
			if better(c) {
				cc := c
				best = &cc
			}
			return nil
		})
	}
	if best == nil {
		return "", ""
	}
	if best.exact {
		return best.path, "gefunden: " + best.path
	}
	return best.path, "vermutlich (zuletzt in Flash Studio geslict): " + best.path
}

// autoModelLoop prüft, ob der Drucker einen neuen Auftrag hat, und lädt die passende Datei.
func (a *App) autoModelLoop() {
	lastJob := ""
	for range time.Tick(5 * time.Second) {
		c := a.config()
		a.mu.Lock()
		running := a.running
		a.mu.Unlock()
		if !running || !c.AutoModel {
			continue
		}
		info := a.printer.Info()
		job := info.FileName
		if job == "" || job == lastJob {
			continue
		}
		lastJob = job
		// passt das aktuelle Modell schon und enthält es Slicer-Angaben? Dann nichts tun.
		if normBase(c.ModelName) == normBase(job) && !a.fileMeta().empty() {
			continue
		}
		// frisch geslicte Dateien: ab ca. Druckbeginn (bzw. 6 h zurück)
		since := time.Now().Add(-6 * time.Hour)
		if info.ElapsedSec > 0 {
			since = time.Now().Add(-time.Duration(info.ElapsedSec)*time.Second - 2*time.Hour)
		}
		path, how := findPrintFile(job, since)
		if path == "" {
			log.Printf("Druckdatei %q nicht auf dem PC gefunden", job)
			continue
		}
		// gefundene Datei nur übernehmen, wenn sie besser ist als die aktuelle
		if normBase(c.ModelName) == normBase(job) && !isSliced(path) {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		// unter dem Namen des Druckauftrags anzeigen, mit der Endung der gefundenen Datei
		name := stem(job) + modelExtOf(path)
		err = a.storeModel(name, f, how)
		f.Close()
		log.Printf("Modell automatisch geladen (%s): %v", how, err)
	}
}
