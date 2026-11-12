package main

import (
	"context"
	"net"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type ScanHit struct {
	IP     string `json:"ip"`
	Name   string `json:"name,omitempty"`
	Camera bool   `json:"camera"` // Kamera-URL liefert Bilder bzw. eine Seite
	Kind   string `json:"kind,omitempty"`
}

type ScanResult struct {
	Port     string    `json:"port"`
	Networks []string  `json:"networks"`
	Hits     []ScanHit `json:"hits"`
}

// scanNetwork prüft alle Adressen der eigenen /24-Netze auf den Kamera-Port
// und testet bei offenen Ports, ob dort wirklich eine Kamera antwortet.
func scanNetwork(ctx context.Context, tpl string) ScanResult {
	port := scanPort(tpl)
	res := ScanResult{Port: port, Hits: []ScanHit{}}

	own := map[string]bool{}
	var targets []string
	seen := map[string]bool{}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipn.IP.To4()
			if ip4 == nil || !ip4.IsPrivate() {
				continue
			}
			own[ip4.String()] = true
			prefix := ip4.Mask(net.CIDRMask(24, 32)).String()
			if seen[prefix] {
				continue
			}
			seen[prefix] = true
			res.Networks = append(res.Networks, prefix+"/24")
			base := ip4.Mask(net.CIDRMask(24, 32))
			for i := 1; i < 255; i++ {
				targets = append(targets, net.IPv4(base[0], base[1], base[2], byte(i)).String())
			}
		}
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	jobs := make(chan string)
	for w := 0; w < 128; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				if own[ip] || ctx.Err() != nil {
					continue
				}
				c, err := net.DialTimeout("tcp", net.JoinHostPort(ip, port), 500*time.Millisecond)
				if err != nil {
					continue
				}
				c.Close()
				hit := ScanHit{IP: ip}
				if p := probeURL(strings.ReplaceAll(tpl, "{ip}", ip), false); p.OK {
					hit.Camera, hit.Kind = true, p.Kind
				}
				lctx, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
				if names, err := net.DefaultResolver.LookupAddr(lctx, ip); err == nil && len(names) > 0 {
					hit.Name = strings.TrimSuffix(names[0], ".")
				}
				cancel()
				mu.Lock()
				res.Hits = append(res.Hits, hit)
				mu.Unlock()
			}
		}()
	}
	for _, t := range targets {
		jobs <- t
	}
	close(jobs)
	wg.Wait()

	sort.Slice(res.Hits, func(i, j int) bool {
		a, b := res.Hits[i], res.Hits[j]
		if a.Camera != b.Camera {
			return a.Camera
		}
		if a.Kind != b.Kind { // echte Videostreams vor Webseiten
			return a.Kind != "page"
		}
		return ipLess(a.IP, b.IP)
	})
	return res
}

// scanPort: Port aus einer URL-Vorlage wie "http://{ip}:8080/?action=stream"
func scanPort(tpl string) string {
	u, err := url.Parse(strings.ReplaceAll(tpl, "{ip}", "host.invalid"))
	if err == nil {
		if p := u.Port(); p != "" {
			return p
		} else if u.Scheme == "https" {
			return "443"
		}
	}
	return "80"
}

func ipLess(a, b string) bool {
	x, y := net.ParseIP(a).To4(), net.ParseIP(b).To4()
	for i := 0; i < 4; i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return false
}
