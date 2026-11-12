package main

// Automatische Druckersuche.
// Reihenfolge: 1) zuletzt bekannte IP, 2) Flashforge-Suchprotokoll per UDP (so findet auch
// Flash Studio die Drucker), 3) IP-Adressen aus den Einstellungsdateien von Flash Studio,
// 4) notfalls Netzwerkscan auf Port 8899.
// Protokoll laut Community-Doku github.com/Parallel-7/flashforge-api-docs (Discovery Protocol).

import (
	"bufio"
	"context"
	"encoding/binary"
	"io/fs"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type FoundPrinter struct {
	IP     string `json:"ip"`
	Name   string `json:"name,omitempty"`
	Model  string `json:"model,omitempty"`
	Serial string `json:"serial,omitempty"`
	Source string `json:"source"` // zuletzt | netzwerk | flashstudio | scan
}

var ffPIDs = map[uint16]string{
	0x0023: "Adventurer 5M", 0x0024: "Adventurer 5M Pro", 0x0026: "AD5X", 0x0028: "Creator 5", 0x0029: "Creator 5 Pro",
	0x0008: "Adventurer 3", 0x0016: "Adventurer 4 Lite", 0x001E: "Adventurer 4 Pro",
}

func cstr(b []byte) string {
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		b = b[:i]
	}
	return strings.TrimSpace(strings.ToValidUTF8(string(b), ""))
}

// parseDiscovery wertet ein Antwortpaket aus (modern: >=276 Byte, alt: 140 Byte).
func parseDiscovery(b []byte) (FoundPrinter, bool) {
	if len(b) < 140 {
		return FoundPrinter{}, false
	}
	p := FoundPrinter{Name: cstr(b[:128]), Source: "netzwerk"}
	pid := binary.BigEndian.Uint16(b[0x88:])
	p.Model = ffPIDs[pid]
	if len(b) >= 276 {
		p.Serial = cstr(b[0x92 : 0x92+128])
	}
	return p, true
}

// udpDiscover schickt leere Pakete an die bekannten Such-Adressen und sammelt Antworten.
func udpDiscover(ctx context.Context, wait time.Duration) []FoundPrinter {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		log.Println("Suche (UDP):", err)
		return nil
	}
	defer conn.Close()

	targets := []string{"225.0.0.9:19000", "225.0.0.9:8899", "255.255.255.255:48899", "255.255.255.255:19000",
		"255.255.255.255:8899", "127.0.0.1:48899", "127.0.0.1:19000"}
	for _, bc := range subnetBroadcasts() {
		targets = append(targets, bc+":48899", bc+":19000")
	}
	send := func() {
		for _, t := range targets {
			if a, err := net.ResolveUDPAddr("udp4", t); err == nil {
				_, _ = conn.WriteToUDP(nil, a)
			}
		}
	}
	send()

	var out []FoundPrinter
	seen := map[string]bool{}
	deadline := time.Now().Add(wait)
	resend := time.Now().Add(wait / 3)
	buf := make([]byte, 2048)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, from, err := conn.ReadFromUDP(buf)
		if time.Now().After(resend) { // UDP kann verloren gehen -> zweimal nachfragen
			send()
			resend = resend.Add(wait / 3)
		}
		if err != nil {
			continue
		}
		p, ok := parseDiscovery(buf[:n])
		if !ok || from == nil {
			continue
		}
		p.IP = from.IP.String()
		if !seen[p.IP] {
			seen[p.IP] = true
			out = append(out, p)
		}
	}
	return out
}

func subnetBroadcasts() []string {
	var out []string
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				if ip := n.IP.To4(); ip != nil {
					bc := make(net.IP, 4)
					for i := range bc {
						bc[i] = ip[i] | ^n.Mask[len(n.Mask)-4+i]
					}
					out = append(out, bc.String())
				}
			}
		}
	}
	return out
}

// ---------- Hinweise aus Flash Studio ----------

var reIPv4 = regexp.MustCompile(`\b((?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3})\b`)

// flashStudioIPs durchsucht die Einstellungsordner von Flash Studio / Orca-Flashforge /
// FlashPrint nach privaten IP-Adressen. Die Dateiformate sind nicht dokumentiert, deshalb
// wird jede gefundene Adresse anschließend am Drucker überprüft.
func flashStudioIPs() []string {
	var roots []string
	for _, base := range []string{os.Getenv("APPDATA"), os.Getenv("LOCALAPPDATA"), func() string { d, _ := os.UserConfigDir(); return d }()} {
		if base == "" {
			continue
		}
		entries, _ := os.ReadDir(base)
		for _, e := range entries {
			n := strings.ToLower(e.Name())
			if e.IsDir() && (strings.Contains(n, "flash") || strings.Contains(n, "orca")) && !strings.Contains(n, "druckmonitor") {
				roots = append(roots, filepath.Join(base, e.Name()))
			}
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.Count(strings.TrimPrefix(path, root), string(os.PathSeparator)) > 3 {
					return filepath.SkipDir
				}
				n := strings.ToLower(d.Name())
				if n == "cache" || n == "log" || n == "logs" || n == "ota" || n == "webview2" || strings.HasPrefix(n, "ebwebview") {
					return filepath.SkipDir
				}
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext != ".conf" && ext != ".json" && ext != ".ini" && ext != ".cfg" && ext != ".config" && ext != ".xml" {
				return nil
			}
			if info, err := d.Info(); err != nil || info.Size() > 4<<20 {
				return nil
			}
			f, err := os.Open(path)
			if err != nil {
				return nil
			}
			sc := bufio.NewScanner(f)
			sc.Buffer(make([]byte, 64<<10), 4<<20)
			for sc.Scan() {
				for _, m := range reIPv4.FindAllString(sc.Text(), -1) {
					ip := net.ParseIP(m).To4()
					if ip != nil && ip.IsPrivate() && ip[3] != 0 && ip[3] != 255 && !seen[m] {
						seen[m] = true
						out = append(out, m)
					}
				}
			}
			f.Close()
			return nil
		})
	}
	return out
}

// ---------- Prüfen / Identifizieren ----------

// identifyFlashforge fragt Name und Seriennummer per TCP (Port 8899) ab.
func identifyFlashforge(ctx context.Context, ip string) (FoundPrinter, bool) {
	p := NewPrinterPoller()
	info, err := p.pollTCP(ctx, ip)
	if err != nil {
		return FoundPrinter{}, false
	}
	return FoundPrinter{IP: ip, Name: info.Machine, Serial: info.Serial}, true
}

func portOpen(ip, port string, timeout time.Duration) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(ip, port), timeout)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// looksLikePrinter: offener Drucker-Port (8899/8898) oder Kamera-Port.
func looksLikePrinter(ip, camPort string) bool {
	return portOpen(ip, "8899", 700*time.Millisecond) || portOpen(ip, "8898", 700*time.Millisecond) ||
		(camPort != "" && portOpen(ip, camPort, 700*time.Millisecond))
}

func camPortOf(tpl string) string {
	return scanPort(tpl)
}

// DiscoverResult für die Oberfläche
type DiscoverResult struct {
	Found  []FoundPrinter `json:"found"`
	Chosen *FoundPrinter  `json:"chosen,omitempty"`
}

// discoverPrinters sucht Drucker. quick=true: aufhören, sobald einer sicher gefunden ist.
func discoverPrinters(ctx context.Context, c Config, quick bool) DiscoverResult {
	var res DiscoverResult
	camPort := camPortOf(c.URLTemplate)
	serial := strings.TrimSpace(c.FFSerial)
	add := func(p FoundPrinter) {
		for i, q := range res.Found {
			if q.IP == p.IP {
				if res.Found[i].Serial == "" {
					res.Found[i].Serial = p.Serial
				}
				if res.Found[i].Name == "" {
					res.Found[i].Name = p.Name
				}
				return
			}
		}
		res.Found = append(res.Found, p)
	}
	matches := func(p FoundPrinter) bool { return serial == "" || strings.EqualFold(p.Serial, serial) }

	// 1) zuletzt bekannte IP noch gültig?
	if last := cleanHost(c.IP); last != "" && looksLikePrinter(last, camPort) {
		p := FoundPrinter{IP: last, Source: "zuletzt"}
		if id, ok := identifyFlashforge(ctx, last); ok {
			p.Name, p.Serial = id.Name, id.Serial
		}
		if serial == "" || p.Serial == "" || matches(p) {
			add(p)
			if quick {
				res.Chosen = &res.Found[len(res.Found)-1]
				return res
			}
		}
	}

	// 2) Flashforge-Suchprotokoll
	for _, p := range udpDiscover(ctx, 2500*time.Millisecond) {
		add(p)
	}

	// 3) Hinweise aus Flash Studio (nur übernehmen, wenn dort wirklich ein Drucker antwortet)
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, ip := range flashStudioIPs() {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			if !looksLikePrinter(ip, camPort) {
				return
			}
			p := FoundPrinter{IP: ip, Source: "flashstudio"}
			if id, ok := identifyFlashforge(ctx, ip); ok {
				p.Name, p.Serial = id.Name, id.Serial
			}
			mu.Lock()
			add(p)
			mu.Unlock()
		}(ip)
	}
	wg.Wait()

	// 4) Notfalls Netzwerkscan auf den Flashforge-Port 8899
	if len(res.Found) == 0 {
		for _, h := range scanNetwork(ctx, "tcp://{ip}:8899").Hits {
			p := FoundPrinter{IP: h.IP, Name: h.Name, Source: "scan"}
			if id, ok := identifyFlashforge(ctx, h.IP); ok {
				p.Name, p.Serial = id.Name, id.Serial
				add(p)
			}
		}
	}

	// Auswahl: passende Seriennummer > zuletzt bekannte IP > erster Fund
	for i := range res.Found {
		if serial != "" && strings.EqualFold(res.Found[i].Serial, serial) {
			res.Chosen = &res.Found[i]
			return res
		}
	}
	if serial == "" {
		for i := range res.Found {
			if res.Found[i].IP == cleanHost(c.IP) {
				res.Chosen = &res.Found[i]
				return res
			}
		}
		if len(res.Found) > 0 {
			res.Chosen = &res.Found[0]
		}
	} else {
		// Seriennummer bekannt, aber kein Treffer mit Seriennummer: Geräte ohne gemeldete Seriennummer zulassen
		for i := range res.Found {
			if res.Found[i].Serial == "" {
				res.Chosen = &res.Found[i]
				break
			}
		}
	}
	return res
}

// ---------- Wächter: IP im laufenden Betrieb nachführen ----------

// applyIP übernimmt eine neue Drucker-IP und startet Kamera und Druckerdaten neu.
func (a *App) applyIP(ip, why string) {
	a.mu.Lock()
	if a.cfg.IP == ip {
		a.mu.Unlock()
		return
	}
	log.Printf("Drucker-IP: %s -> %s (%s)", a.cfg.IP, ip, why)
	a.cfg.IP = ip
	c := a.cfg
	running := a.running
	a.mu.Unlock()
	_ = a.saveConfig(c)
	if running {
		if c.Mode != "page" {
			a.stream.Start(c.StreamURL())
		}
		a.printer.Start(c)
	}
}

func (a *App) watchIP() {
	var problemSince time.Time
	for range time.Tick(10 * time.Second) {
		c := a.config()
		a.mu.Lock()
		running := a.running
		a.mu.Unlock()
		if !running || !c.AutoIP {
			problemSince = time.Time{}
			continue
		}
		st := a.stream.Status()
		camBad := c.Mode != "page" && (st["state"] == "error" || st["state"] == "connecting")
		dataBad := c.PrinterKind == "flashforge" && a.printer.Info().State == "offline"
		if !camBad && !dataBad {
			problemSince = time.Time{}
			continue
		}
		if problemSince.IsZero() {
			problemSince = time.Now()
		}
		if time.Since(problemSince) < 30*time.Second {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		res := discoverPrinters(ctx, c, false)
		cancel()
		if res.Chosen != nil && res.Chosen.IP != c.IP {
			a.applyIP(res.Chosen.IP, "automatisch neu gefunden")
			problemSince = time.Time{}
		} else {
			problemSince = time.Now().Add(-20 * time.Second) // in ~20 s erneut versuchen
		}
	}
}
