//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// Updates nur für die installierte Version (nicht für eine lose kopierte EXE)
var updateSupported = func() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(filepath.Dir(exe), "Deinstallieren.exe"))
	return err == nil
}()

const createBreakawayFromJob = 0x01000000

// launchInstaller startet den Installer unsichtbar. Er darf das Ende der App überleben
// (die App steckt für ihre Hilfsprozesse in einem Job-Objekt, das beim Beenden alles schließt).
func launchInstaller(path string) error {
	start := func(flags uint32) error {
		cmd := exec.Command(path, "/S", "/UPDATE")
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags}
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	}
	err := start(createBreakawayFromJob | createNoWindow)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "access") {
		err = start(createNoWindow) // falls ein fremdes Job-Objekt kein Herauslösen erlaubt
	}
	return err
}
