package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestJobFileName(t *testing.T) {
	for in, want := range map[string]string{"Größe Würfel 2": "Groesse_Wuerfel_2.gcode", "../x": "x.gcode", "": "druck.gcode"} {
		if got := jobFileName(in); got != want {
			t.Errorf("jobFileName(%q)=%q, erwartet %q", in, got, want)
		}
	}
}

func TestFFUploadGcode(t *testing.T) {
	var gotHeaders http.Header
	var gotName, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/uploadGcode" {
			w.WriteHeader(404)
			return
		}
		gotHeaders = r.Header.Clone()
		f, h, err := r.FormFile("gcodeFile")
		if err != nil {
			t.Error(err)
			return
		}
		b, _ := io.ReadAll(f)
		gotName, gotBody = h.Filename, string(b)
		w.Write([]byte(`{"code":0,"message":"Success"}`))
	}))
	defer srv.Close()
	host, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	ffHTTPPort = port
	defer func() { ffHTTPPort = "8898" }()
	tmp, _ := os.CreateTemp("", "*.gcode")
	tmp.WriteString("G28\nG1 X0\n")
	tmp.Close()
	defer os.Remove(tmp.Name())
	if err := ffUploadGcode(host, "SN1", "CODE", tmp.Name(), "test.gcode", true); err != nil {
		t.Fatal(err)
	}
	if gotName != "test.gcode" || gotBody != "G28\nG1 X0\n" {
		t.Fatalf("Datei falsch: %q %q", gotName, gotBody)
	}
	for k, v := range map[string]string{"Serialnumber": "SN1", "Checkcode": "CODE", "Filesize": "10", "Printnow": "true", "Levelingbeforeprint": "true"} {
		if gotHeaders.Get(k) != v {
			t.Errorf("Header %s = %q, erwartet %q", k, gotHeaders.Get(k), v)
		}
	}
}
