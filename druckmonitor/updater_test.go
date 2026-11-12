package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		less bool
	}{{"1.1.0", "1.2.0", true}, {"1.10.0", "1.9.0", false}, {"dev", "1.0.0", true}, {"1.2", "1.2.0", false}, {"1.2.0", "1.2.1", true}}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.less {
			t.Errorf("versionLess(%q,%q)=%v", c.a, c.b, got)
		}
	}
}

func TestDownloadInstaller(t *testing.T) {
	payload := []byte("MZ installer bytes")
	sum := sha256.Sum256(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		w.Write(payload)
	}))
	defer srv.Close()
	a := &App{cfg: Config{ServerURL: srv.URL, ServerToken: "tok"}}
	path, err := a.downloadInstaller(&UpdateInfo{Version: "1.2.0", Size: int64(len(payload)), Sha256: hex.EncodeToString(sum[:]), URL: "/f"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != string(payload) {
		t.Fatal("Inhalt falsch")
	}
	if _, err := a.downloadInstaller(&UpdateInfo{Version: "1.2.0", Sha256: "00", URL: "/f"}); err == nil {
		t.Fatal("falsche Prüfsumme nicht erkannt")
	}
}
