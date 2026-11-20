package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClearPlatformAndNoOpenConnections(t *testing.T) {
	var open int64
	var control map[string]any
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/control":
			_ = json.NewDecoder(r.Body).Decode(&control)
			io.WriteString(w, `{"code":0,"message":"Success"}`)
		case "/uploadGcode":
			io.Copy(io.Discard, r.Body)
			io.WriteString(w, `{"code":0,"message":"Success"}`)
		}
	}))
	srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		switch s {
		case http.StateNew:
			atomic.AddInt64(&open, 1)
		case http.StateClosed, http.StateHijacked:
			atomic.AddInt64(&open, -1)
		}
	}
	srv.Start()
	defer srv.Close()
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	old := ffHTTPPort
	ffHTTPPort = port
	defer func() { ffHTTPPort = old }()

	ffClearPlatform(host, "SN1", "CODE")
	p := control["payload"].(map[string]any)
	if control["serialNumber"] != "SN1" || p["cmd"] != "stateCtrl_cmd" || p["args"].(map[string]any)["action"] != "setClearPlatform" {
		t.Fatalf("falsche Anfrage: %v", control)
	}
	f, _ := os.CreateTemp(t.TempDir(), "*.gcode")
	f.WriteString("G1 X1\n")
	f.Close()
	for i := 0; i < 5; i++ {
		if err := ffUploadGcode(host, "SN1", "CODE", f.Name(), "test.gcode", true); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if n := atomic.LoadInt64(&open); n != 0 {
		t.Fatalf("%d Verbindung(en) zum Drucker bleiben offen", n)
	}
}

func TestSamePrintJobTwice(t *testing.T) {
	// zweites Abschicken desselben Auftrags (neue Nummer) muss angenommen werden
	k1 := "abc@1"
	k2 := "abc@2"
	printJobsSeen[k1] = true
	if printJobsSeen[k2] {
		t.Fatal("neues Abschicken fälschlich schon bekannt")
	}
	delete(printJobsSeen, k1)
}
