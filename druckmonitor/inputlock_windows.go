package main

import (
	"errors"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const inputLockSupported = true

var (
	ilUser32             = syscall.NewLazyDLL("user32.dll")
	ilKernel32           = syscall.NewLazyDLL("kernel32.dll")
	pSetWindowsHookExW   = ilUser32.NewProc("SetWindowsHookExW")
	pUnhookWindowsHookEx = ilUser32.NewProc("UnhookWindowsHookEx")
	pCallNextHookEx      = ilUser32.NewProc("CallNextHookEx")
	pGetMessageW         = ilUser32.NewProc("GetMessageW")
	pPostThreadMessageW  = ilUser32.NewProc("PostThreadMessageW")
	pOpenInputDesktop    = ilUser32.NewProc("OpenInputDesktop")
	pCloseDesktop        = ilUser32.NewProc("CloseDesktop")
	pGetUserObjectInfo   = ilUser32.NewProc("GetUserObjectInformationW")
	pGetLastInputInfo    = ilUser32.NewProc("GetLastInputInfo")
	pGetCurrentThreadId  = ilKernel32.NewProc("GetCurrentThreadId")
	pGetModuleHandleW    = ilKernel32.NewProc("GetModuleHandleW")
	pGetTickCount        = ilKernel32.NewProc("GetTickCount")
)

const (
	whKeyboardLL = 13
	whMouseLL    = 14
	wmQuit       = 0x0012
)

var (
	hookMu     sync.Mutex
	hookThread uint32
	hookActive bool
	// Rückruffunktionen nur einmal anlegen (Windows begrenzt die Anzahl)
	kbProc    = syscall.NewCallback(func(code, wparam, lparam uintptr) uintptr { return blockOrPass(code, wparam, lparam) })
	mouseProc = syscall.NewCallback(func(code, wparam, lparam uintptr) uintptr { return blockOrPass(code, wparam, lparam) })
)

func blockOrPass(code, wparam, lparam uintptr) uintptr {
	if int32(code) >= 0 {
		hookMu.Lock()
		on := hookActive
		hookMu.Unlock()
		if on {
			return 1 // Eingabe verschlucken
		}
	}
	r, _, _ := pCallNextHookEx.Call(0, code, wparam, lparam)
	return r
}

// platformLockInput: Tastatur- und Maus-Filter für das ganze System (geht ohne Administrator-Rechte).
// onSAS wird aufgerufen, wenn Windows den Sicherheitsbildschirm (Strg+Alt+Entf) oder den Sperrbildschirm zeigt.
func platformLockInput(onSAS func()) error {
	hookMu.Lock()
	if hookActive {
		hookMu.Unlock()
		return nil
	}
	hookMu.Unlock()
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		tid, _, _ := pGetCurrentThreadId.Call()
		mod, _, _ := pGetModuleHandleW.Call(0)
		kb, _, e1 := pSetWindowsHookExW.Call(whKeyboardLL, kbProc, mod, 0)
		ms, _, e2 := pSetWindowsHookExW.Call(whMouseLL, mouseProc, mod, 0)
		if kb == 0 || ms == 0 {
			if kb != 0 {
				pUnhookWindowsHookEx.Call(kb)
			}
			if ms != 0 {
				pUnhookWindowsHookEx.Call(ms)
			}
			ready <- errors.New("Eingabe-Filter nicht möglich: " + e1.Error() + " / " + e2.Error())
			return
		}
		hookMu.Lock()
		hookThread, hookActive = uint32(tid), true
		hookMu.Unlock()
		ready <- nil
		var msg [48]byte
		for {
			r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
			if int32(r) <= 0 { // WM_QUIT oder Fehler
				break
			}
		}
		pUnhookWindowsHookEx.Call(kb)
		pUnhookWindowsHookEx.Call(ms)
		hookMu.Lock()
		hookActive, hookThread = false, 0
		hookMu.Unlock()
	}()
	if err := <-ready; err != nil {
		return err
	}
	// Wächter: Strg+Alt+Entf schaltet auf den Desktop „Winlogon“ – dann entsperren
	go func() {
		for {
			time.Sleep(250 * time.Millisecond)
			hookMu.Lock()
			on := hookActive
			hookMu.Unlock()
			if !on {
				return
			}
			if inputDesktopName() != "Default" {
				onSAS()
				return
			}
		}
	}()
	return nil
}

func platformUnlockInput() {
	hookMu.Lock()
	tid := hookThread
	hookActive = false // sofort durchlassen, auch bevor der Filter entfernt ist
	hookMu.Unlock()
	if tid != 0 {
		pPostThreadMessageW.Call(uintptr(tid), wmQuit, 0, 0)
	}
}

// inputDesktopName: Name des Desktops, der gerade Eingaben bekommt ("Default" = normaler Desktop).
func inputDesktopName() string {
	h, _, _ := pOpenInputDesktop.Call(0, 0, 0x0001) // DESKTOP_READOBJECTS
	if h == 0 {
		return "?" // kein Zugriff = Sicherheits- oder Sperrbildschirm
	}
	defer pCloseDesktop.Call(h)
	var buf [128]uint16
	var need uint32
	r, _, _ := pGetUserObjectInfo.Call(h, 2 /* UOI_NAME */, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&need)))
	if r == 0 {
		return "?"
	}
	return syscall.UTF16ToString(buf[:])
}

// idleTime: Zeit seit der letzten Eingabe am PC.
func idleTime() time.Duration {
	var lii struct {
		Size uint32
		Time uint32
	}
	lii.Size = uint32(unsafe.Sizeof(lii))
	if r, _, _ := pGetLastInputInfo.Call(uintptr(unsafe.Pointer(&lii))); r == 0 {
		return 0
	}
	now, _, _ := pGetTickCount.Call()
	return time.Duration(uint32(now)-lii.Time) * time.Millisecond
}
