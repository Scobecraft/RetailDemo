package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Stream holt die Kamerabilder des Druckers und hält immer das neueste Bild bereit.
// Hängt die Verbindung (keine neuen Bilder, oder immer dasselbe Bild), wird sie
// automatisch neu aufgebaut – das ersetzt das unzuverlässige "alle 30 s aktualisieren".
type Stream struct {
	mu        sync.Mutex
	notify    chan struct{}
	frame     []byte
	seq       uint64
	lastFrame time.Time
	lastHash  [20]byte
	sameSince time.Time
	state     string // idle | connecting | live | error | page
	kind      string // mjpeg | snapshot | page
	errMsg    string
	url       string
	cancel    context.CancelFunc
	fpsCount  int
	fpsStart  time.Time
	fps       float64
	reconnect int
}

const (
	stallTimeout  = 6 * time.Second  // so lange ohne neues Bild -> neu verbinden
	frozenTimeout = 45 * time.Second // so lange exakt dasselbe Bild -> neu verbinden
	maxFrameBytes = 20 << 20
)

func NewStream() *Stream {
	return &Stream{notify: make(chan struct{}), state: "idle"}
}

func (s *Stream) Start(url string) {
	s.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.cancel, s.url, s.state, s.kind, s.errMsg, s.reconnect = cancel, url, "connecting", "", "", 0
	s.frame, s.lastFrame = nil, time.Time{}
	s.mu.Unlock()
	go s.run(ctx, url)
}

func (s *Stream) Stop() {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.state = "idle"
	s.mu.Unlock()
}

func (s *Stream) setState(state, kind, msg string) {
	s.mu.Lock()
	s.state, s.errMsg = state, msg
	if kind != "" {
		s.kind = kind
	}
	s.mu.Unlock()
}

func (s *Stream) setFrame(b []byte) {
	h := sha1.Sum(b)
	now := time.Now()
	s.mu.Lock()
	if h != s.lastHash {
		s.lastHash, s.sameSince = h, now
	}
	s.frame, s.lastFrame = b, now
	s.seq++
	s.state, s.errMsg = "live", ""
	s.fpsCount++
	if d := now.Sub(s.fpsStart); d >= 2*time.Second {
		s.fps = float64(s.fpsCount) / d.Seconds()
		s.fpsCount, s.fpsStart = 0, now
	}
	close(s.notify)
	s.notify = make(chan struct{})
	s.mu.Unlock()
}

// frozen meldet, ob seit längerem nur noch identische Bilder kommen.
func (s *Stream) frozen() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.sameSince.IsZero() && time.Since(s.sameSince) > frozenTimeout
}

// Wait liefert ein Bild, das neuer als after ist (oder nil nach Ablauf von timeout).
func (s *Stream) Wait(ctx context.Context, after uint64, timeout time.Duration) ([]byte, uint64) {
	t := time.NewTimer(timeout)
	defer t.Stop()
	for {
		s.mu.Lock()
		if s.frame != nil && s.seq > after {
			f, q := s.frame, s.seq
			s.mu.Unlock()
			return f, q
		}
		ch := s.notify
		s.mu.Unlock()
		select {
		case <-ch:
		case <-t.C:
			return nil, 0
		case <-ctx.Done():
			return nil, 0
		}
	}
}

func (s *Stream) Status() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	age := int64(-1)
	if !s.lastFrame.IsZero() {
		age = time.Since(s.lastFrame).Milliseconds()
	}
	fps := s.fps
	if age > 3000 {
		fps = 0
	}
	return map[string]any{
		"state": s.state, "kind": s.kind, "error": s.errMsg, "url": s.url,
		"ageMs": age, "fps": fps, "seq": s.seq, "reconnects": s.reconnect,
	}
}

var errFrozen = errors.New("Kamerabild eingefroren – verbinde neu")
var errStalled = errors.New("keine neuen Bilder – verbinde neu")

func (s *Stream) run(ctx context.Context, url string) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := s.once(ctx, url)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		msg := "Verbindung getrennt"
		if err != nil {
			msg = friendlyErr(err)
		}
		log.Printf("Stream %s: %s", url, msg)
		s.mu.Lock()
		s.reconnect++
		if s.state != "page" {
			s.state, s.errMsg = "error", msg
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 5*time.Second {
			backoff *= 2
		}
	}
}

func newClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy:                 nil, // Drucker steht im lokalen Netz
		DialContext:           (&net.Dialer{Timeout: 4 * time.Second}).DialContext,
		ResponseHeaderTimeout: 8 * time.Second,
		DisableKeepAlives:     true,
	}}
}

// once baut eine Verbindung auf und liest so lange Bilder, bis etwas schiefgeht.
func (s *Stream) once(parent context.Context, url string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	s.mu.Lock()
	s.lastHash, s.sameSince = [20]byte{}, time.Time{} // Einfrier-Erkennung neu starten
	s.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := newClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Drucker antwortet mit HTTP %d", resp.StatusCode)
	}
	mt, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))

	switch {
	case strings.HasPrefix(mt, "image/"):
		return s.pollSnapshots(ctx, url, resp)
	case mt == "text/html":
		// Eine Webseite statt eines Videostreams: die Oberfläche bettet sie ein
		// und lädt sie regelmäßig neu. Hier nur die Erreichbarkeit beobachten.
		s.setState("page", "page", "")
		resp.Body.Close()
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(10 * time.Second):
			}
			if r := probeURL(url, false); !r.OK {
				return errors.New(r.Error)
			}
			s.setState("page", "page", "")
		}
	default: // multipart/x-mixed-replace oder unbekannt -> MJPEG
		s.setState("connecting", "mjpeg", "")
		return s.readMJPEG(parent, cancel, resp.Body)
	}
}

func (s *Stream) readMJPEG(parent context.Context, cancel context.CancelFunc, body io.Reader) error {
	var stalled bool
	var smu sync.Mutex
	watchdog := time.AfterFunc(stallTimeout+4*time.Second, func() { // erstes Bild darf etwas länger dauern
		smu.Lock()
		stalled = true
		smu.Unlock()
		cancel()
	})
	defer watchdog.Stop()

	soi, eoi := []byte{0xFF, 0xD8, 0xFF}, []byte{0xFF, 0xD9}
	buf := make([]byte, 0, 1<<20)
	tmp := make([]byte, 64<<10)
	for {
		n, err := body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			for {
				start := bytes.Index(buf, soi)
				if start < 0 {
					if len(buf) > 2 {
						buf = append(buf[:0], buf[len(buf)-2:]...)
					}
					break
				}
				end := bytes.Index(buf[start+2:], eoi)
				if end < 0 {
					if start > 0 {
						buf = append(buf[:0], buf[start:]...)
					}
					if len(buf) > maxFrameBytes {
						buf = buf[:0]
					}
					break
				}
				end = start + 2 + end + 2
				frame := bytes.Clone(buf[start:end])
				buf = append(buf[:0], buf[end:]...)
				s.setFrame(frame)
				watchdog.Reset(stallTimeout)
				if s.frozen() {
					return errFrozen
				}
			}
		}
		if err != nil {
			smu.Lock()
			st := stalled
			smu.Unlock()
			if parent.Err() != nil {
				return nil // absichtlich beendet
			}
			if st {
				return errStalled
			}
			if err == io.EOF {
				return errors.New("Stream wurde vom Drucker beendet")
			}
			return err
		}
	}
}

// pollSnapshots: Die URL liefert Einzelbilder – regelmäßig neu abrufen.
func (s *Stream) pollSnapshots(ctx context.Context, url string, first *http.Response) error {
	s.setState("connecting", "snapshot", "")
	b, err := io.ReadAll(io.LimitReader(first.Body, maxFrameBytes))
	if err != nil {
		return err
	}
	s.setFrame(b)
	client := newClient()
	client.Timeout = stallTimeout
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(150 * time.Millisecond):
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxFrameBytes))
		resp.Body.Close()
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("Drucker antwortet mit HTTP %d", resp.StatusCode)
		}
		s.setFrame(b)
		if s.frozen() {
			return errFrozen
		}
	}
}

func friendlyErr(err error) string {
	var ne net.Error
	msg := err.Error()
	switch {
	case errors.Is(err, errFrozen), errors.Is(err, errStalled):
		return msg
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "actively refused"):
		return "Drucker erreichbar, aber die Verbindung wird abgelehnt (falscher Port oder Dienst aus)"
	case strings.Contains(msg, "no route to host"), strings.Contains(msg, "unreachable"):
		return "Drucker nicht erreichbar – IP prüfen"
	case errors.As(err, &ne) && ne.Timeout():
		return "Zeitüberschreitung – Drucker antwortet nicht (IP prüfen)"
	}
	return msg
}

// ---------- Verbindungstest ----------

type ProbeResult struct {
	OK          bool   `json:"ok"`
	Kind        string `json:"kind"` // mjpeg | snapshot | page
	ContentType string `json:"contentType"`
	Error       string `json:"error,omitempty"`
	Preview     string `json:"preview,omitempty"` // data:-URL eines Bildes
}

func probeURL(url string, withPreview bool) ProbeResult {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ProbeResult{Error: "Ungültige Adresse: " + err.Error()}
	}
	resp, err := newClient().Do(req)
	if err != nil {
		return ProbeResult{Error: friendlyErr(err)}
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	mt, _, _ := mime.ParseMediaType(ct)
	r := ProbeResult{ContentType: ct}
	if resp.StatusCode != http.StatusOK {
		r.Error = fmt.Sprintf("Drucker antwortet mit HTTP %d (Pfad falsch?)", resp.StatusCode)
		return r
	}
	switch {
	case strings.HasPrefix(mt, "image/"):
		r.OK, r.Kind = true, "snapshot"
		if withPreview {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, maxFrameBytes))
			r.Preview = "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(b)
		}
	case mt == "text/html":
		r.OK, r.Kind = true, "page"
	default:
		r.OK, r.Kind = true, "mjpeg"
		if withPreview {
			if f := firstJPEG(resp.Body); f != nil {
				r.Preview = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(f)
			} else {
				r.OK, r.Error = false, "Antwort enthält keine Kamerabilder ("+ct+")"
			}
		}
	}
	return r
}

func firstJPEG(rd io.Reader) []byte {
	buf := make([]byte, 0, 512<<10)
	tmp := make([]byte, 32<<10)
	for len(buf) < maxFrameBytes {
		n, err := rd.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if s := bytes.Index(buf, []byte{0xFF, 0xD8, 0xFF}); s >= 0 {
			if e := bytes.Index(buf[s+2:], []byte{0xFF, 0xD9}); e >= 0 {
				return bytes.Clone(buf[s : s+2+e+2])
			}
		}
		if err != nil {
			return nil
		}
	}
	return nil
}
