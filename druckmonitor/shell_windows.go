//go:build windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
)

func init() { runtime.LockOSThread() } // Fenster muss im Haupt-Thread laufen

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pMessageBoxW                   = user32.NewProc("MessageBoxW")
	pSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	pEnumDisplayMonitors           = user32.NewProc("EnumDisplayMonitors")
	pGetMonitorInfoW               = user32.NewProc("GetMonitorInfoW")
	pMonitorFromWindow             = user32.NewProc("MonitorFromWindow")
	pGetWindowLongPtrW             = user32.NewProc("GetWindowLongPtrW")
	pSetWindowLongPtrW             = user32.NewProc("SetWindowLongPtrW")
	pGetWindowRect                 = user32.NewProc("GetWindowRect")
	pSetWindowPos                  = user32.NewProc("SetWindowPos")
	pShowWindow                    = user32.NewProc("ShowWindow")
	pSetForegroundWindow           = user32.NewProc("SetForegroundWindow")
	pSetThreadExecutionState       = kernel32.NewProc("SetThreadExecutionState")
)

const (
	wsOverlappedWindow = 0x00CF0000
	wsPopup            = 0x80000000
	wsVisible          = 0x10000000
	swpFrameChanged    = 0x0020
	swpShowWindow      = 0x0040
	swpNoZOrder        = 0x0004
	swShowNormal       = 1
	monitorDefaultNear = 2
	mbIconError        = 0x10
)

var gwlStyle = -16

type rect struct{ Left, Top, Right, Bottom int32 }

type monitorInfoEx struct {
	CbSize    uint32
	RcMonitor rect
	RcWork    rect
	DwFlags   uint32
	SzDevice  [32]uint16
}

type winWindow struct {
	w          webview2.WebView
	mu         sync.Mutex
	fullscreen bool
	savedStyle uintptr
	savedRect  rect
}

func fatal(msg string) {
	t, _ := syscall.UTF16PtrFromString("Druckmonitor")
	m, _ := syscall.UTF16PtrFromString(msg)
	pMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbIconError)
	os.Exit(1)
}

func runShell(app *App, base string) {
	// Gestochen scharf auf hochauflösenden Monitoren
	if pSetProcessDpiAwarenessContext.Find() == nil {
		pSetProcessDpiAwarenessContext.Call(^uintptr(3)) // PER_MONITOR_AWARE_V2 (-4)
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(app.dir, "WebView2"),
		WindowOptions: webview2.WindowOptions{
			Title: "Druckmonitor", Width: 1100, Height: 820, IconId: 1, Center: true,
		},
	})
	if w == nil {
		fatal("Microsoft Edge WebView2 Runtime wurde nicht gefunden.\n\n" +
			"Bitte installieren: https://go.microsoft.com/fwlink/p/?LinkId=2124703\n" +
			"(Bei Windows 10/11 ist sie normalerweise schon vorhanden.)")
	}
	app.win = &winWindow{w: w}

	// Bildschirmschoner und Standby verhindern, solange die App läuft
	pSetThreadExecutionState.Call(0x80000000 | 0x1 | 0x2)

	w.Navigate(base)
	if app.autostarted && app.config().Fullscreen {
		go func() {
			time.Sleep(800 * time.Millisecond)
			app.win.SetFullscreen(true, app.config().Monitor)
		}()
	}
	w.Run()
	app.stream.Stop()
	os.Exit(0)
}

func (x *winWindow) Quit() {
	x.w.Dispatch(func() { x.w.Terminate() })
}

func (x *winWindow) SetFullscreen(on bool, monitor int) {
	x.w.Dispatch(func() {
		x.mu.Lock()
		defer x.mu.Unlock()
		hwnd := uintptr(x.w.Window())
		if on {
			if !x.fullscreen {
				x.savedStyle, _, _ = pGetWindowLongPtrW.Call(hwnd, uintptr(gwlStyle))
				pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&x.savedRect)))
			}
			r, ok := monitorRect(monitor)
			if !ok {
				var mi monitorInfoEx
				mi.CbSize = uint32(unsafe.Sizeof(mi))
				hm, _, _ := pMonitorFromWindow.Call(hwnd, monitorDefaultNear)
				pGetMonitorInfoW.Call(hm, uintptr(unsafe.Pointer(&mi)))
				r = mi.RcMonitor
			}
			style := (x.savedStyle &^ wsOverlappedWindow) | wsPopup | wsVisible
			pSetWindowLongPtrW.Call(hwnd, uintptr(gwlStyle), style)
			pSetWindowPos.Call(hwnd, 0, uintptr(r.Left), uintptr(r.Top),
				uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top), swpFrameChanged|swpShowWindow)
			x.fullscreen = true
		} else if x.fullscreen {
			pSetWindowLongPtrW.Call(hwnd, uintptr(gwlStyle), x.savedStyle)
			r := x.savedRect
			pSetWindowPos.Call(hwnd, 0, uintptr(r.Left), uintptr(r.Top),
				uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top), swpFrameChanged|swpShowWindow|swpNoZOrder)
			pShowWindow.Call(hwnd, swShowNormal)
			x.fullscreen = false
		}
		pSetForegroundWindow.Call(hwnd)
	})
}

// ---------- Monitore ----------

type monEntry struct {
	info monitorInfoEx
}

var (
	monMu   sync.Mutex
	monList []monEntry
	monCB   = syscall.NewCallback(func(hm, hdc, lprc, lparam uintptr) uintptr {
		var mi monitorInfoEx
		mi.CbSize = uint32(unsafe.Sizeof(mi))
		pGetMonitorInfoW.Call(hm, uintptr(unsafe.Pointer(&mi)))
		monList = append(monList, monEntry{mi})
		return 1
	})
)

func enumMonitors() []monEntry {
	monMu.Lock()
	defer monMu.Unlock()
	monList = nil
	pEnumDisplayMonitors.Call(0, 0, monCB, 0)
	l := append([]monEntry(nil), monList...)
	sort.SliceStable(l, func(i, j int) bool {
		pi, pj := l[i].info.DwFlags&1 != 0, l[j].info.DwFlags&1 != 0
		if pi != pj {
			return pi
		}
		return l[i].info.RcMonitor.Left < l[j].info.RcMonitor.Left
	})
	return l
}

func monitorRect(i int) (rect, bool) {
	l := enumMonitors()
	if i < 0 || i >= len(l) {
		return rect{}, false
	}
	return l[i].info.RcMonitor, true
}

func (x *winWindow) Monitors() []MonitorInfo {
	var out []MonitorInfo
	for i, m := range enumMonitors() {
		r := m.info.RcMonitor
		out = append(out, MonitorInfo{
			Index: i, Name: syscall.UTF16ToString(m.info.SzDevice[:]),
			Width: int(r.Right - r.Left), Height: int(r.Bottom - r.Top),
			Primary: m.info.DwFlags&1 != 0,
		})
	}
	return out
}
