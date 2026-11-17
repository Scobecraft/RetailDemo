package main

// Feierabend: Der PC fährt nach Zeitplan herunter (Standard Mo–Fr 19:00, Sa 16:00), eingestellt auf der
// Retail-Demo-Webseite. Der Plan wird lokal gespeichert, damit es auch ohne Server klappt.
// Sicherungen: läuft ein Druck, wird gewartet; vorher Hinweis im Monitor mit „Heute nicht“; wird der PC
// erst nach der Uhrzeit eingeschaltet, fährt er nicht gleich wieder herunter; Windows warnt 60 s vorher.

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type ShutdownDay struct {
	On   bool   `json:"on"`
	Time string `json:"time"` // HH:MM
}

type ShutdownPlan struct {
	Enabled          bool          `json:"enabled"`
	Days             []ShutdownDay `json:"days"` // Montag … Sonntag
	NotWhilePrinting bool          `json:"not_while_printing"`
	WarnMin          int           `json:"warn_min"`
	SkipDate         string        `json:"skip_date"`
	ForceDate        string        `json:"force_date"`
	Rev              int64         `json:"rev"`
}

func defaultShutdownPlan() ShutdownPlan {
	d := []ShutdownDay{}
	for i := 0; i < 5; i++ {
		d = append(d, ShutdownDay{true, "19:00"})
	}
	d = append(d, ShutdownDay{true, "16:00"}, ShutdownDay{false, "16:00"})
	return ShutdownPlan{Enabled: true, Days: d, NotWhilePrinting: true, WarnMin: 5}
}

// Grace: so lange nach der Uhrzeit wird noch heruntergefahren (wer den PC später einschaltet, wird nicht überrascht)
const shutdownGrace = 20 * time.Minute

type shutdownState struct {
	mu        sync.Mutex
	plan      ShutdownPlan
	localSkip string    // Datum, an dem im Monitor „Heute nicht“ gedrückt wurde
	doneDate  string    // Datum, an dem schon heruntergefahren wurde
	pending   time.Time // Uhrzeit erreicht, wartet auf Druckende
	state     string    // idle | warning | waiting_print | shutting_down | skipped | off
	at        time.Time // heutiger Zeitpunkt
	started   time.Time // Programmstart
}

var shutdown = &shutdownState{state: "idle", started: time.Now()}

func (a *App) shutdownFile() string { return filepath.Join(a.dir, "herunterfahren.json") }

func (a *App) loadShutdown() {
	s := shutdown
	s.mu.Lock()
	defer s.mu.Unlock()
	s.plan = defaultShutdownPlan()
	var saved struct {
		Plan      *ShutdownPlan `json:"plan"`
		LocalSkip string        `json:"localSkip"`
		DoneDate  string        `json:"doneDate"`
	}
	if b, err := os.ReadFile(a.shutdownFile()); err == nil && json.Unmarshal(b, &saved) == nil {
		if saved.Plan != nil && len(saved.Plan.Days) == 7 {
			s.plan = *saved.Plan
		}
		s.localSkip, s.doneDate = saved.LocalSkip, saved.DoneDate
	}
}

func (a *App) saveShutdownLocked() {
	s := shutdown
	b, _ := json.MarshalIndent(map[string]any{"plan": s.plan, "localSkip": s.localSkip, "doneDate": s.doneDate}, "", "  ")
	_ = os.WriteFile(a.shutdownFile(), b, 0o644)
}

// onShutdownPlan übernimmt den Plan vom Server (Antwort auf die Zustandsmeldung).
func (a *App) onShutdownPlan(p *ShutdownPlan) {
	if p == nil || len(p.Days) != 7 {
		return
	}
	s := shutdown
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Rev == s.plan.Rev && p.SkipDate == s.plan.SkipDate && p.ForceDate == s.plan.ForceDate {
		return
	}
	today := time.Now().Format("2006-01-02")
	if p.ForceDate == today && s.localSkip == today { // Webseite: „heute doch herunterfahren“
		s.localSkip = ""
	}
	s.plan = *p
	a.saveShutdownLocked()
}

func parseHM(day time.Time, hm string) (time.Time, bool) {
	t, err := time.ParseInLocation("15:04", hm, time.Local)
	if err != nil {
		return time.Time{}, false
	}
	return time.Date(day.Year(), day.Month(), day.Day(), t.Hour(), t.Minute(), 0, 0, time.Local), true
}

// todayAt: heutiger Zeitpunkt laut Plan (ok=false: heute nicht vorgesehen)
func (p ShutdownPlan) todayAt(now time.Time) (time.Time, bool) {
	if !p.Enabled || len(p.Days) != 7 {
		return time.Time{}, false
	}
	d := p.Days[(int(now.Weekday())+6)%7]
	if !d.On {
		return time.Time{}, false
	}
	return parseHM(now, d.Time)
}

// nextAt: nächster geplanter Zeitpunkt (für die Anzeige)
func (p ShutdownPlan) nextAt(now time.Time) time.Time {
	for i := 0; i < 8; i++ {
		day := now.AddDate(0, 0, i)
		if t, ok := p.todayAt(day); ok && t.After(now) {
			return t
		}
	}
	return time.Time{}
}

func (a *App) printing() bool {
	st := a.printer.Info().State
	return st == "printing" || st == "paused" || st == "heating"
}

func (a *App) shutdownLoop() {
	a.loadShutdown()
	for {
		a.shutdownTick(time.Now())
		time.Sleep(15 * time.Second)
	}
}

func (a *App) shutdownTick(now time.Time) {
	s := shutdown
	s.mu.Lock()
	defer s.mu.Unlock()
	today := now.Format("2006-01-02")
	p := s.plan
	at, ok := p.todayAt(now)
	s.at = at
	skipped := s.localSkip == today || p.SkipDate == today
	switch {
	case !p.Enabled:
		s.state, s.pending = "off", time.Time{}
		return
	case s.doneDate == today && s.state == "shutting_down":
		return
	case skipped:
		s.state, s.pending = "skipped", time.Time{}
		return
	}
	// Uhrzeit erreicht (aber nicht, wenn der PC erst danach eingeschaltet wurde)
	if ok && s.doneDate != today && !now.Before(at) && now.Before(at.Add(shutdownGrace)) && s.started.Before(at.Add(-time.Minute)) && s.pending.IsZero() {
		s.pending = now
	}
	if !s.pending.IsZero() {
		if now.Sub(s.pending) > 12*time.Hour { // z. B. Druck lief die ganze Nacht: nicht mehr nachholen
			s.pending, s.state = time.Time{}, "idle"
			return
		}
		if p.NotWhilePrinting && a.printing() {
			s.state = "waiting_print"
			return
		}
		s.state, s.doneDate, s.pending = "shutting_down", today, time.Time{}
		a.saveShutdownLocked()
		log.Println("Feierabend: PC wird heruntergefahren")
		go shutdownPC()
		return
	}
	if ok && s.doneDate != today && p.WarnMin > 0 && now.Before(at) && !now.Before(at.Add(-time.Duration(p.WarnMin)*time.Minute)) {
		s.state = "warning"
		return
	}
	s.state = "idle"
}

func (a *App) shutdownStatus() map[string]any {
	s := shutdown
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	next := s.plan.nextAt(now)
	m := map[string]any{"state": s.state, "enabled": s.plan.Enabled, "skippedToday": s.localSkip == now.Format("2006-01-02") || s.plan.SkipDate == now.Format("2006-01-02")}
	if !s.at.IsZero() {
		m["todayAt"] = s.at.Unix()
	}
	if !next.IsZero() {
		m["next"] = next.Unix()
	}
	return m
}

// handleShutdown: GET Status · POST ?action=skip (heute nicht) / unskip
func (a *App) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		s := shutdown
		s.mu.Lock()
		today := time.Now().Format("2006-01-02")
		switch r.URL.Query().Get("action") {
		case "skip":
			s.localSkip, s.pending = today, time.Time{}
			if s.state == "shutting_down" {
				go abortShutdownPC()
				s.doneDate = ""
			}
			s.state = "skipped"
		case "unskip":
			s.localSkip = ""
		}
		a.saveShutdownLocked()
		s.mu.Unlock()
	}
	writeJSON(w, a.shutdownStatus())
}
