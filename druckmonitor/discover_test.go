package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func TestParseDiscoveryModern(t *testing.T) {
	b := make([]byte, 280) // Firmware 5.x: 280 Byte
	copy(b, "Werkstatt-Drucker")
	binary.BigEndian.PutUint16(b[0x84:], 8899)
	binary.BigEndian.PutUint16(b[0x88:], 0x0023)
	copy(b[0x92:], "SNMOMC1234567")
	p, ok := parseDiscovery(b)
	if !ok || p.Name != "Werkstatt-Drucker" || p.Model != "Adventurer 5M" || p.Serial != "SNMOMC1234567" {
		t.Fatalf("modern: %+v ok=%v", p, ok)
	}
}

func TestParseDiscoveryLegacy(t *testing.T) {
	b := make([]byte, 140)
	copy(b, "Adventurer3")
	binary.BigEndian.PutUint16(b[0x88:], 0x0008)
	p, ok := parseDiscovery(b)
	if !ok || p.Name != "Adventurer3" || p.Model != "Adventurer 3" || p.Serial != "" {
		t.Fatalf("legacy: %+v", p)
	}
	if _, ok := parseDiscovery(make([]byte, 60)); ok {
		t.Fatal("zu kurzes Paket akzeptiert")
	}
}

func TestFlashStudioIPs(t *testing.T) {
	appdata := t.TempDir()
	t.Setenv("APPDATA", appdata)
	t.Setenv("LOCALAPPDATA", "")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := filepath.Join(appdata, "Orca-Flashforge", "user")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(appdata, "Orca-Flashforge", "OrcaSlicer.conf"),
		[]byte(`{"app":{"last_device":"192.168.178.57"},"proxy":"8.8.8.8","broadcast":"192.168.178.255"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "devices.json"), []byte(`[{"ip":"10.0.0.23","sn":"SN1"}]`), 0o644)
	os.WriteFile(filepath.Join(dir, "bild.png"), []byte(`192.168.1.99`), 0o644) // falscher Dateityp
	os.MkdirAll(filepath.Join(appdata, "Fremdprogramm"), 0o755)
	os.WriteFile(filepath.Join(appdata, "Fremdprogramm", "x.json"), []byte(`"192.168.5.5"`), 0o644)

	got := flashStudioIPs()
	sort.Strings(got)
	want := []string{"10.0.0.23", "192.168.178.57"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("gefunden %v, erwartet %v", got, want)
	}
}

func TestFindPrintFile(t *testing.T) {
	tmp, home := t.TempDir(), t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TEMP", tmp)
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("APPDATA", "")
	t.Setenv("LOCALAPPDATA", "")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	os.MkdirAll(filepath.Join(home, "Downloads"), 0o755)
	os.WriteFile(filepath.Join(home, "Downloads", "Gecko.stl"), []byte("solid x"), 0o644)
	if p, _ := findPrintFile("Gecko.3mf", time.Now().Add(-time.Hour)); filepath.Base(p) != "Gecko.stl" {
		t.Fatalf("STL nicht gefunden: %q", p)
	}
	// geslicte Fassung im Temp-Ordner von Flash Studio wird bevorzugt
	d := filepath.Join(tmp, "orca-flashforge_model", "1")
	os.MkdirAll(d, 0o755)
	os.WriteFile(filepath.Join(d, "Gecko.gcode"), []byte("; x\nG1 X1 E1\n"), 0o644)
	if p, _ := findPrintFile("Gecko.3mf", time.Now().Add(-time.Hour)); filepath.Base(p) != "Gecko.gcode" {
		t.Fatalf("geslicte Datei nicht bevorzugt: %q", p)
	}
	if normBase("Gecko_PLA.gcode.3mf") != "gecko_pla" || stem("Gecko_PLA.gcode.3mf") != "Gecko_PLA" || modelExtOf("a.GCODE.3mf") != ".gcode.3mf" {
		t.Fatal("Namensfunktionen")
	}
}
