package main

// PC-Werte für die Webseite des Retail-Demo-Servers: laufende Auslastung (CPU, RAM, GPU, Netzwerk,
// Datenträger, Prozesse) und die verbaute Hardware. Gemessen wird nur, solange an den Server
// gesendet wird. Die Messung selbst steckt in sysstats_windows.go bzw. sysstats_other.go.

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"
)

type PCDisk struct {
	Mount  string `json:"mount"`
	Label  string `json:"label,omitempty"`
	UsedB  uint64 `json:"usedB"`
	TotalB uint64 `json:"totalB"`
}

type PCGPU struct {
	Name      string  `json:"name,omitempty"`
	Pct       float64 `json:"pct"`       // -1 = unbekannt
	MemUsedB  uint64  `json:"memUsedB"`  // 0 = unbekannt
	MemTotalB uint64  `json:"memTotalB"` // 0 = unbekannt
	TempC     float64 `json:"tempC"`     // -1 = unbekannt
	PowerW    float64 `json:"powerW"`    // -1 = unbekannt
	FanPct    float64 `json:"fanPct"`    // -1 = unbekannt
	ClockMHz  float64 `json:"clockMHz"`  // -1 = unbekannt
}

type PCProc struct {
	Name   string  `json:"name"`
	CPUPct float64 `json:"cpuPct"`
	MemB   uint64  `json:"memB"`
}

// PCStats: aktuelle Messwerte (alle 2 s).
type PCStats struct {
	TS        int64     `json:"ts"`
	Host      string    `json:"host"`
	UptimeSec float64   `json:"uptimeSec"`
	CPUPct    float64   `json:"cpuPct"`
	Cores     []float64 `json:"cores,omitempty"` // Auslastung je logischem Kern
	RAMUsedB  uint64    `json:"ramUsedB"`
	RAMTotalB uint64    `json:"ramTotalB"`
	GPUs      []PCGPU   `json:"gpus,omitempty"`
	NetRxBps  float64   `json:"netRxBps"` // -1 = unbekannt
	NetTxBps  float64   `json:"netTxBps"`
	DiskRBps  float64   `json:"diskReadBps"` // -1 = unbekannt
	DiskWBps  float64   `json:"diskWriteBps"`
	DiskBusy  float64   `json:"diskBusyPct"` // -1 = unbekannt
	Disks     []PCDisk  `json:"disks,omitempty"`
	Procs     []PCProc  `json:"procs,omitempty"`
}

type PCRAMModule struct {
	Slot     string `json:"slot,omitempty"`
	SizeB    uint64 `json:"sizeB"`
	SpeedMHz int    `json:"speedMHz,omitempty"`
	Maker    string `json:"maker,omitempty"`
	Part     string `json:"part,omitempty"`
}

type PCInfoGPU struct {
	Name    string `json:"name"`
	Driver  string `json:"driver,omitempty"`
	VRAMB   uint64 `json:"vramB,omitempty"`
	Display string `json:"display,omitempty"` // z. B. "2560 × 1440 · 144 Hz"
}

type PCInfoDisk struct {
	Name  string `json:"name"`
	Type  string `json:"type,omitempty"` // SSD, HDD
	Bus   string `json:"bus,omitempty"`  // NVMe, SATA, USB …
	SizeB uint64 `json:"sizeB"`
}

type PCInfoNIC struct {
	Name  string `json:"name"`
	Speed string `json:"speed,omitempty"`
}

// PCInfo: verbaute Hardware (wird einmal ermittelt).
type PCInfo struct {
	Host       string        `json:"host"`
	System     string        `json:"system,omitempty"` // Hersteller + Modell des PCs
	OS         string        `json:"os,omitempty"`
	CPU        string        `json:"cpu,omitempty"`
	Cores      int           `json:"cores,omitempty"`
	Threads    int           `json:"threads,omitempty"`
	CPUMaxMHz  int           `json:"cpuMaxMHz,omitempty"`
	RAMTotalB  uint64        `json:"ramTotalB,omitempty"`
	RAMModules []PCRAMModule `json:"ramModules,omitempty"`
	Board      string        `json:"board,omitempty"`
	BIOS       string        `json:"bios,omitempty"`
	GPUs       []PCInfoGPU   `json:"gpus,omitempty"`
	Disks      []PCInfoDisk  `json:"disks,omitempty"`
	NICs       []PCInfoNIC   `json:"nics,omitempty"`
}

// SysMonitor misst im Hintergrund, solange es gebraucht wird.
type SysMonitor struct {
	mu      sync.Mutex
	stats   *PCStats
	info    *PCInfo
	started bool
	wanted  time.Time // zuletzt abgefragt; ohne Abfrage ruht die Messung
}

var sysMon = &SysMonitor{}

// Latest liefert die neuesten Messwerte (nil, solange noch keine vorliegen) und hält die Messung am Laufen.
func (m *SysMonitor) Latest() (*PCStats, *PCInfo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.wanted = time.Now()
	if !m.started {
		m.started = true
		go m.run()
	}
	return m.stats, m.info
}

func (m *SysMonitor) active() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return time.Since(m.wanted) < 30*time.Second
}

func (m *SysMonitor) setStats(s *PCStats) {
	m.mu.Lock()
	m.stats = s
	m.mu.Unlock()
}

func (m *SysMonitor) setInfo(i *PCInfo) {
	m.mu.Lock()
	m.info = i
	m.mu.Unlock()
}

// jnum liest Zahlen, die als Zahl oder als Text ("1234") kommen.
type jnum float64

func (n *jnum) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*n = 0
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		*n = 0
		return nil
	}
	*n = jnum(f)
	return nil
}

// jstr liest Texte, die auch als Zahl kommen können (z. B. Aufzählungswerte).
type jstr string

func (s *jstr) UnmarshalJSON(b []byte) error {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return nil
	}
	switch t := v.(type) {
	case string:
		*s = jstr(strings.TrimSpace(t))
	case float64:
		*s = jstr(strconv.FormatFloat(t, 'f', -1, 64))
	default:
		*s = ""
	}
	return nil
}

// list liest einen JSON-Wert, der ein einzelnes Objekt oder eine Liste sein kann (PowerShell).
func list[T any](raw json.RawMessage) []T {
	var many []T
	if json.Unmarshal(raw, &many) == nil {
		return many
	}
	var one T
	if json.Unmarshal(raw, &one) == nil {
		return []T{one}
	}
	return nil
}
