package main

import (
	"testing"
	"time"
)

func at(s string) time.Time { t, _ := time.ParseInLocation("2006-01-02 15:04", s, time.Local); return t }

func TestShutdownPlan(t *testing.T) {
	p := defaultShutdownPlan()
	// 17.11.2026 ist ein Dienstag, 21.11. ein Samstag, 22.11. ein Sonntag
	if x, ok := p.todayAt(at("2026-11-17 10:00")); !ok || x.Format("15:04") != "19:00" {
		t.Fatal("Dienstag 19:00 erwartet", x, ok)
	}
	if x, ok := p.todayAt(at("2026-11-21 10:00")); !ok || x.Format("15:04") != "16:00" {
		t.Fatal("Samstag 16:00 erwartet", x)
	}
	if _, ok := p.todayAt(at("2026-11-22 10:00")); ok {
		t.Fatal("Sonntag aus")
	}
	if n := p.nextAt(at("2026-11-21 17:00")); n.Format("2006-01-02 15:04") != "2026-11-23 19:00" {
		t.Fatal("nach Samstag 17 Uhr: Montag 19:00 erwartet, nicht", n)
	}
}

func TestShutdownTickStartedLate(t *testing.T) {
	a := &App{dir: t.TempDir(), printer: NewPrinterPoller()}
	shutdown = &shutdownState{plan: defaultShutdownPlan(), state: "idle", started: at("2026-11-17 19:05")}
	a.shutdownTick(at("2026-11-17 19:06"))
	if shutdown.state == "shutting_down" || !shutdown.pending.IsZero() {
		t.Fatal("PC wurde erst nach 19 Uhr eingeschaltet – darf nicht herunterfahren")
	}
	shutdown = &shutdownState{plan: defaultShutdownPlan(), state: "idle", started: at("2026-11-17 08:00")}
	a.shutdownTick(at("2026-11-17 18:57"))
	if shutdown.state != "warning" {
		t.Fatal("3 Minuten vorher: Warnung erwartet, nicht", shutdown.state)
	}
	shutdown.localSkip = "2026-11-17"
	a.shutdownTick(at("2026-11-17 19:01"))
	if shutdown.state != "skipped" {
		t.Fatal("heute ausgelassen erwartet")
	}
}
