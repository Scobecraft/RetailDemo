//go:build !windows

package main

import (
	"fmt"
	"os"
)

// Entwicklungs-/Testvariante ohne eigenes Fenster: Oberfläche im Browser öffnen.
func runShell(app *App, base string) {
	fmt.Println("Druckmonitor läuft auf", base)
	if f := os.Getenv("DRUCKMONITOR_URLFILE"); f != "" {
		_ = os.WriteFile(f, []byte(base), 0o644)
	}
	select {}
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}
