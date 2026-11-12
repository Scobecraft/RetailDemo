package main

// Live-Daten vom Flashforge-Drucker.
//  - HTTP-Schnittstelle (Port 8898, Adventurer 5M / 5M Pro / AD5X): braucht Seriennummer + Prüfcode,
//    liefert dafür am meisten (Restzeit, Filament, Lüfter, Geschwindigkeit …).
//  - TCP-Schnittstelle (Port 8899): ohne Zugangsdaten, liefert Temperaturen, Fortschritt,
//    Schicht, Status und Dateiname.
// Quelle der Protokolldetails: Community-Dokumentation github.com/Parallel-7/flashforge-api-docs

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type PrinterInfo struct {
	Source       string  `json:"source"` // http | tcp
	Online       bool    `json:"online"`
	State        string  `json:"state"`  // idle | printing | paused | heating | done | busy | error | offline
	Status       string  `json:"status"` // deutscher Text
	Error        string  `json:"error,omitempty"`
	Machine      string  `json:"machine,omitempty"`
	Firmware     string  `json:"firmware,omitempty"`
	Serial       string  `json:"serial,omitempty"`
	FileName     string  `json:"fileName,omitempty"`
	Progress     float64 `json:"progress"` // 0..1, -1 = unbekannt
	Layer        int     `json:"layer"`
	Layers       int     `json:"layers"`
	ElapsedSec   float64 `json:"elapsedSec"`   // -1 = unbekannt
	RemainingSec float64 `json:"remainingSec"` // -1 = unbekannt
	RemainingEst bool    `json:"remainingEst"` // Restzeit selbst hochgerechnet (ungenauer)
	Nozzle       float64 `json:"nozzle"`
	NozzleTarget float64 `json:"nozzleTarget"`
	Bed          float64 `json:"bed"`
	BedTarget    float64 `json:"bedTarget"`
	Chamber      float64 `json:"chamber"`
	SpeedPct     float64 `json:"speedPct"` // -1 = unbekannt
	SpeedMMs     float64 `json:"speedMms"`
	FanPct       float64 `json:"fanPct"` // -1 = unbekannt
	FilamentType string  `json:"filamentType,omitempty"`
	FilamentM    float64 `json:"filamentM"` // -1 = unbekannt
	FilamentG    float64 `json:"filamentG"` // -1 = unbekannt
	Light        string  `json:"light,omitempty"`
	Updated      int64   `json:"updated"` // Unix-ms
}

func unknownInfo() PrinterInfo {
	return PrinterInfo{Progress: -1, ElapsedSec: -1, RemainingSec: -1, SpeedPct: -1, FanPct: -1, FilamentM: -1, FilamentG: -1}
}

type PrinterPoller struct {
	mu     sync.Mutex
	info   PrinterInfo
	cancel context.CancelFunc

	// für TCP: Druckbeginn selbst mitschreiben (TCP liefert keine Zeiten)
	tcpStart  time.Time
	rateStart time.Time // Beginn der Tempo-Messung
	rateP0    float64   // Fortschritt zu diesem Zeitpunkt
}

func NewPrinterPoller() *PrinterPoller {
	i := unknownInfo()
	i.State, i.Status = "offline", "Keine Druckerdaten"
	return &PrinterPoller{info: i}
}

func (p *PrinterPoller) Info() PrinterInfo {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.info
}

func (p *PrinterPoller) Stop() {
	p.mu.Lock()
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
	i := unknownInfo()
	i.State, i.Status = "offline", "Keine Druckerdaten"
	p.info = i
	p.mu.Unlock()
}

func (p *PrinterPoller) Start(c Config) {
	p.Stop()
	if c.PrinterKind != "flashforge" || cleanHost(c.IP) == "" {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.mu.Lock()
	p.cancel = cancel
	p.tcpStart = time.Time{}
	p.rateStart = time.Time{}
	p.info.Status = "Verbinde …"
	p.mu.Unlock()
	go p.run(ctx, c)
}

func (p *PrinterPoller) run(ctx context.Context, c Config) {
	host := cleanHost(c.IP)
	useHTTP := strings.TrimSpace(c.FFSerial) != "" && strings.TrimSpace(c.FFCheckCode) != ""
	fails := 0
	for ctx.Err() == nil {
		var info PrinterInfo
		var err error
		if useHTTP {
			info, err = ffHTTPDetail(ctx, host, c.FFSerial, c.FFCheckCode)
			if err != nil && fails >= 2 {
				// HTTP klappt nicht (z. B. falscher Prüfcode) -> wenigstens TCP-Daten zeigen
				if ti, terr := p.pollTCP(ctx, host); terr == nil {
					ti.Error = "HTTP-Schnittstelle: " + err.Error()
					info, err = ti, nil
				}
			}
		} else {
			info, err = p.pollTCP(ctx, host)
		}
		if ctx.Err() != nil {
			return
		}
		p.mu.Lock()
		if err != nil {
			fails++
			if fails >= 3 { // kurze Aussetzer nicht sofort anzeigen
				i := unknownInfo()
				i.State, i.Status, i.Error = "offline", "Drucker nicht erreichbar", err.Error()
				i.Updated = time.Now().UnixMilli()
				p.info = i
			}
			if fails == 3 {
				log.Println("Druckerdaten:", err)
			}
		} else {
			fails = 0
			info.Online = true
			info.Updated = time.Now().UnixMilli()
			p.info = info
		}
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// ---------- HTTP (Port 8898) ----------

var httpStatusDE = map[string][2]string{
	"ready": {"idle", "Bereit"}, "busy": {"busy", "Beschäftigt"}, "calibrate_doing": {"busy", "Kalibriert"},
	"error": {"error", "Fehler"}, "heating": {"heating", "Heizt auf"}, "printing": {"printing", "Druckt"},
	"pausing": {"paused", "Pausiert …"}, "pause": {"paused", "Pausiert"}, "canceling": {"busy", "Bricht ab …"},
	"cancel": {"idle", "Abgebrochen"}, "completed": {"done", "Fertig"}, "downloading": {"busy", "Empfängt Datei"},
	"cloud_slicing": {"busy", "Slict"}, "sending": {"busy", "Empfängt Datei"}, "unzipping": {"busy", "Entpackt Datei"},
}

func ffHTTPDetail(ctx context.Context, host, serial, code string) (PrinterInfo, error) {
	body, _ := json.Marshal(map[string]string{"serialNumber": strings.TrimSpace(serial), "checkCode": strings.TrimSpace(code)})
	rctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(rctx, http.MethodPost, "http://"+net.JoinHostPort(host, "8898")+"/detail", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := newClient().Do(req)
	if err != nil {
		return PrinterInfo{}, errors.New(friendlyErr(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return PrinterInfo{}, err
	}
	var env struct {
		Code    int                    `json:"code"`
		Message string                 `json:"message"`
		Detail  map[string]interface{} `json:"detail"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return PrinterInfo{}, fmt.Errorf("unerwartete Antwort (HTTP %d)", resp.StatusCode)
	}
	switch env.Code {
	case 0:
	case 1:
		return PrinterInfo{}, errors.New("Seriennummer oder Prüfcode falsch")
	case -2:
		return PrinterInfo{}, errors.New("LAN-Modus am Drucker ist nicht aktiviert")
	default:
		return PrinterInfo{}, fmt.Errorf("Drucker meldet Fehler %d: %s", env.Code, env.Message)
	}
	return parseFFDetail(env.Detail), nil
}

func num(m map[string]interface{}, k string) (float64, bool) {
	switch v := m[k].(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}

func str(m map[string]interface{}, k string) string {
	if v, ok := m[k].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func parseFFDetail(d map[string]interface{}) PrinterInfo {
	i := unknownInfo()
	i.Source = "http"
	st := strings.ToLower(str(d, "status"))
	if m, ok := httpStatusDE[st]; ok {
		i.State, i.Status = m[0], m[1]
	} else {
		i.State, i.Status = "busy", st
	}
	i.Machine = str(d, "name")
	i.Firmware = str(d, "firmwareVersion")
	i.FileName = str(d, "printFileName")
	if e := str(d, "errorCode"); e != "" && e != "0" {
		i.Error = "Fehlercode " + e
	}
	active := i.State == "printing" || i.State == "paused" || i.State == "heating"
	if v, ok := num(d, "printProgress"); ok {
		if v > 1.0001 { // falls eine Firmware Prozent statt Anteil liefert
			v /= 100
		}
		i.Progress = v
	}
	if v, ok := num(d, "printLayer"); ok {
		i.Layer = int(v)
	}
	if v, ok := num(d, "targetPrintLayer"); ok {
		i.Layers = int(v)
	}
	if v, ok := num(d, "printDuration"); ok && (active || i.State == "done") {
		i.ElapsedSec = v
	}
	if v, ok := num(d, "estimatedTime"); ok && active {
		i.RemainingSec = v // laut Doku bereits die RESTzeit
	}
	// Düse: Einzeldüsen-Drucker melden "right…"; sonst die wärmere nehmen
	r, _ := num(d, "rightTemp")
	l, _ := num(d, "leftTemp")
	rt, _ := num(d, "rightTargetTemp")
	lt, _ := num(d, "leftTargetTemp")
	i.Nozzle, i.NozzleTarget = r, rt
	if r == 0 && l > 0 {
		i.Nozzle, i.NozzleTarget = l, lt
	}
	i.Bed, _ = num(d, "platTemp")
	i.BedTarget, _ = num(d, "platTargetTemp")
	i.Chamber, _ = num(d, "chamberTemp")
	if v, ok := num(d, "printSpeedAdjust"); ok {
		i.SpeedPct = v
	}
	if v, ok := num(d, "currentPrintSpeed"); ok {
		i.SpeedMMs = v
	}
	if v, ok := num(d, "coolingFanSpeed"); ok {
		i.FanPct = v
	}
	i.FilamentType = str(d, "rightFilamentType")
	if i.FilamentType == "" {
		i.FilamentType = str(d, "leftFilamentType")
	}
	if v, ok := num(d, "estimatedRightLen"); ok && v > 0 {
		i.FilamentM = filamentMeters(v)
	} else if v, ok := num(d, "estimatedLeftLen"); ok && v > 0 {
		i.FilamentM = filamentMeters(v)
	}
	if v, ok := num(d, "estimatedRightWeight"); ok && v > 0 {
		i.FilamentG = v
	} else if v, ok := num(d, "estimatedLeftWeight"); ok && v > 0 {
		i.FilamentG = v
	}
	i.Light = str(d, "lightStatus")
	if i.State == "printing" && i.NozzleTarget > 0 && i.Nozzle < i.NozzleTarget-8 {
		i.State, i.Status = "heating", "Heizt auf"
	}
	return i
}

// Die Einheit der Filamentlänge ist nicht dokumentiert: große Werte sind mm.
func filamentMeters(v float64) float64 {
	if v > 500 {
		return v / 1000
	}
	return v
}

// ---------- TCP (Port 8899) ----------

var (
	reTemp     = regexp.MustCompile(`T0:\s*([\d.]+)\s*/\s*([\d.]+)`)
	reBed      = regexp.MustCompile(`B:\s*([\d.]+)\s*/\s*([\d.]+)`)
	reProgress = regexp.MustCompile(`byte\s+(\d+)\s*/\s*(\d+)`)
	reLayer    = regexp.MustCompile(`Layer:\s*(\d+)\s*/\s*(\d+)`)
)

var tcpStatusDE = map[string][2]string{
	"READY": {"idle", "Bereit"}, "BUILDING_FROM_SD": {"printing", "Druckt"}, "BUILDING": {"printing", "Druckt"},
	"PAUSED": {"paused", "Pausiert"}, "BUSY": {"busy", "Beschäftigt"}, "BUILDING_COMPLETED": {"done", "Fertig"},
}

func (p *PrinterPoller) pollTCP(ctx context.Context, host string) (PrinterInfo, error) {
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, "8899"))
	if err != nil {
		return PrinterInfo{}, errors.New(friendlyErr(err))
	}
	defer conn.Close()
	rd := bufio.NewReader(conn)
	cmd := func(c string) (string, error) {
		_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
		if _, err := conn.Write([]byte("~" + c + "\r\n")); err != nil {
			return "", err
		}
		var sb strings.Builder
		for {
			line, err := rd.ReadString('\n')
			sb.WriteString(line)
			t := strings.TrimSpace(line)
			if t == "ok" || strings.HasPrefix(t, "Control Failed") {
				return sb.String(), nil
			}
			if err != nil {
				return sb.String(), err
			}
		}
	}
	ctl, err := cmd("M601 S1")
	if err != nil {
		return PrinterInfo{}, fmt.Errorf("TCP-Anmeldung fehlgeschlagen: %v", err)
	}
	if strings.Contains(ctl, "Control Failed") {
		return PrinterInfo{}, errors.New("Drucker ist gerade von einem anderen Programm belegt")
	}
	defer cmd("M602") // Sitzung wieder freigeben, damit Flash Studio nicht blockiert wird

	i := unknownInfo()
	i.Source = "tcp"
	if r, err := cmd("M115"); err == nil {
		for _, l := range strings.Split(r, "\n") {
			l = strings.TrimSpace(l)
			if v, ok := strings.CutPrefix(l, "Machine Name:"); ok {
				i.Machine = strings.TrimSpace(v)
			} else if v, ok := strings.CutPrefix(l, "Machine Type:"); ok && i.Machine == "" {
				i.Machine = strings.TrimSpace(v)
			} else if v, ok := strings.CutPrefix(l, "SN:"); ok {
				i.Serial = strings.TrimSpace(v)
			} else if v, ok := strings.CutPrefix(l, "Firmware:"); ok {
				i.Firmware = strings.TrimSpace(v)
			}
		}
	}
	r, err := cmd("M119")
	if err != nil {
		return PrinterInfo{}, err
	}
	machineStatus := ""
	for _, l := range strings.Split(r, "\n") {
		l = strings.TrimSpace(l)
		if v, ok := strings.CutPrefix(l, "MachineStatus:"); ok {
			machineStatus = strings.TrimSpace(v)
		} else if v, ok := strings.CutPrefix(l, "CurrentFile:"); ok {
			i.FileName = strings.TrimSpace(v)
		} else if v, ok := strings.CutPrefix(l, "LED:"); ok {
			if strings.TrimSpace(v) == "1" {
				i.Light = "open"
			} else {
				i.Light = "close"
			}
		}
	}
	if m, ok := tcpStatusDE[machineStatus]; ok {
		i.State, i.Status = m[0], m[1]
	} else if machineStatus != "" {
		i.State, i.Status = "busy", machineStatus
	} else {
		i.State, i.Status = "busy", "Unbekannt"
	}
	if r, err := cmd("M105"); err == nil {
		if m := reTemp.FindStringSubmatch(r); m != nil {
			i.Nozzle, _ = strconv.ParseFloat(m[1], 64)
			i.NozzleTarget, _ = strconv.ParseFloat(m[2], 64)
		}
		if m := reBed.FindStringSubmatch(r); m != nil {
			i.Bed, _ = strconv.ParseFloat(m[1], 64)
			i.BedTarget, _ = strconv.ParseFloat(m[2], 64)
		}
	}
	if r, err := cmd("M27"); err == nil {
		if m := reProgress.FindStringSubmatch(r); m != nil {
			a, _ := strconv.ParseFloat(m[1], 64)
			b, _ := strconv.ParseFloat(m[2], 64)
			if b > 0 {
				i.Progress = a / b
			}
		}
		if m := reLayer.FindStringSubmatch(r); m != nil {
			i.Layer, _ = strconv.Atoi(m[1])
			i.Layers, _ = strconv.Atoi(m[2])
		}
	}
	if i.State == "printing" && i.NozzleTarget > 0 && i.Nozzle < i.NozzleTarget-8 {
		i.State, i.Status = "heating", "Heizt auf"
	}

	// Zeiten selbst ermitteln: Druckbeginn merken, Restzeit aus dem Fortschritt hochrechnen
	p.mu.Lock()
	switch i.State {
	case "printing", "paused", "heating":
		if p.tcpStart.Unix() == 0 && !p.tcpStart.IsZero() && i.Progress >= 0 && i.Progress < 0.01 {
			p.tcpStart = time.Time{} // neuer Druck hat begonnen -> ab jetzt mitzählen
		}
		if p.tcpStart.IsZero() {
			p.tcpStart = time.Now()
			if i.Progress > 0.02 { // App wurde mitten im Druck gestartet: Beginn unbekannt
				p.tcpStart = time.Unix(0, 0)
			}
		}
		if p.tcpStart.Unix() > 0 {
			i.ElapsedSec = time.Since(p.tcpStart).Seconds()
		}
		// Restzeit aus dem Drucktempo hochrechnen – gemessen erst ab der ersten Schicht
		// (Aufheizen und Bettvermessung zählen nicht) bzw. ab dem Start der App.
		printingNow := i.State == "printing" && (i.Layer >= 1 || i.Progress > 0)
		if printingNow && p.rateStart.IsZero() {
			p.rateStart, p.rateP0 = time.Now(), math.Max(i.Progress, 0)
		}
		if !p.rateStart.IsZero() && i.Progress >= 0 {
			if i.Progress < p.rateP0 { // neuer Druck
				p.rateStart, p.rateP0 = time.Now(), i.Progress
			}
			dp := i.Progress - p.rateP0
			if dp >= 0.02 {
				perUnit := time.Since(p.rateStart).Seconds() / dp
				i.RemainingSec = perUnit * (1 - i.Progress)
				i.RemainingEst = true
			}
		}
	default:
		p.tcpStart = time.Time{}
		p.rateStart = time.Time{}
	}
	p.mu.Unlock()
	return i, nil
}
