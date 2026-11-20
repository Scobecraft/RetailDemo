package main

// Kundenschutz: Solange die Monitor-Ansicht läuft, sind Tastatur und Maus gesperrt.
// Entsperren: Strg + Alt + Entf (lässt sich unter Windows von keinem Programm abfangen – Windows wechselt in
// den Sicherheitsbildschirm; das erkennt die App und hebt die Sperre auf). Nach 10 Minuten ohne Eingabe
// sperrt sie sich wieder. Von der Retail-Demo-Webseite aus lässt sie sich ebenfalls sperren/entsperren.

import (
	"log"
	"net/http"
	"sync"
	"time"
)

const relockAfter = 10 * time.Minute

type inputLockState struct {
	mu         sync.Mutex
	locked     bool
	enabled    bool // Einstellung „Tastatur & Maus sperren“
	unlockedAt time.Time
	reason     string
	remoteSeq  int64
}

var ilock = &inputLockState{}

func (a *App) setInputLock(on bool, reason string) {
	s := ilock
	s.mu.Lock()
	if s.locked == on {
		s.mu.Unlock()
		return
	}
	s.locked = on
	s.reason = reason
	if !on {
		s.unlockedAt = time.Now()
	}
	s.mu.Unlock()
	var err error
	if on {
		err = platformLockInput(func() { a.setInputLock(false, "Strg+Alt+Entf") })
	} else {
		platformUnlockInput()
	}
	if err != nil {
		log.Println("Eingabesperre:", err)
		s.mu.Lock()
		s.locked = false
		s.mu.Unlock()
		return
	}
	log.Printf("Eingabesperre %s (%s)", map[bool]string{true: "an", false: "aus"}[on], reason)
}

// startInputLock: beim Start der Monitor-Ansicht (wenn in den Einstellungen nicht abgeschaltet)
func (a *App) startInputLock() {
	ilock.mu.Lock()
	ilock.enabled = !a.config().NoInputLock
	en := ilock.enabled
	ilock.mu.Unlock()
	if en {
		a.setInputLock(true, "Programmstart")
	}
}

// inputLockLoop: nach längerer Pause ohne Eingabe wieder sperren
func (a *App) inputLockLoop() {
	for {
		time.Sleep(20 * time.Second)
		ilock.mu.Lock()
		should := ilock.enabled && !ilock.locked && !ilock.unlockedAt.IsZero()
		ilock.mu.Unlock()
		if should && idleTime() > relockAfter {
			a.setInputLock(true, "10 Minuten ohne Eingabe")
		}
	}
}

func (a *App) inputLockStatus() map[string]any {
	s := ilock
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{"locked": s.locked, "enabled": s.enabled, "reason": s.reason, "supported": inputLockSupported}
}

// onRemoteInputLock: Webseite „Sperren“/„Entsperren“ (Antwort auf die Zustandsmeldung)
type RemoteLock struct {
	Seq int64 `json:"seq"`
	On  bool  `json:"on"`
}

func (a *App) onRemoteInputLock(r *RemoteLock) {
	if r == nil || r.Seq == 0 {
		return
	}
	ilock.mu.Lock()
	first := ilock.remoteSeq == 0
	if r.Seq == ilock.remoteSeq {
		ilock.mu.Unlock()
		return
	}
	ilock.remoteSeq = r.Seq
	ilock.mu.Unlock()
	if first && time.Since(time.UnixMilli(r.Seq)) > 2*time.Minute {
		return // alter Befehl von vor dem Programmstart
	}
	a.setInputLock(r.On, "Webseite")
}

func (a *App) handleInputLock(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.inputLockStatus())
}
