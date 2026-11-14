package main

// Druckaufträge von der Retail-Demo-Webseite: Der Server meldet in der Antwort auf die Übertragung
// einen bereitgestellten Auftrag. Die App lädt den G-Code, prüft, dass der Drucker frei ist, und
// schickt die Datei über die HTTP-Schnittstelle des Druckers (Port 8898, braucht Seriennummer und
// Prüfcode) – mit "sofort drucken". Den Stand meldet sie dem Server zurück.
//
// Schnittstelle laut Community-Doku (github.com/Parallel-7/flashforge-api-docs, ff-5mp-api):
// POST http://<ip>:8898/uploadGcode, multipart-Feld "gcodeFile", Kopfzeilen serialNumber, checkCode,
// fileSize, printNow, levelingBeforePrint. Antwort {"code":0} = angenommen.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type PrintJob struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	URL      string `json:"url"`
	Leveling bool   `json:"leveling"`
}

var (
	printJobsMu   sync.Mutex
	printJobsSeen = map[string]bool{}
)

// onPrintJob wird nach jeder Übertragung aufgerufen; jeden Auftrag nur einmal bearbeiten.
func (a *App) onPrintJob(job *PrintJob) {
	if job == nil || job.ID == "" {
		return
	}
	printJobsMu.Lock()
	if printJobsSeen[job.ID] {
		printJobsMu.Unlock()
		return
	}
	printJobsSeen[job.ID] = true
	printJobsMu.Unlock()
	go a.runPrintJob(job)
}

func (a *App) reportJob(id, state, msg string) {
	c := a.config()
	base := serverBase(c.ServerURL)
	body, _ := json.Marshal(map[string]string{"state": state, "message": msg})
	for try := 0; try < 3; try++ {
		req, _ := http.NewRequest(http.MethodPost, base+"/api/druck/jobs/"+id+"/status", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.ServerToken))
		req.Header.Set("Content-Type", "application/json")
		resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return
			}
		}
		time.Sleep(2 * time.Second)
	}
}

func (a *App) runPrintJob(job *PrintJob) {
	log.Printf("Druckauftrag „%s“ empfangen", job.Name)
	a.reportJob(job.ID, "sending", "Druckmonitor lädt die Datei …")
	fail := func(msg string) {
		log.Printf("Druckauftrag „%s“: %s", job.Name, msg)
		a.reportJob(job.ID, "error", msg)
	}
	c := a.config()
	if strings.TrimSpace(c.FFSerial) == "" || strings.TrimSpace(c.FFCheckCode) == "" {
		fail("In der Druckmonitor-App fehlen Seriennummer oder Prüfcode des Druckers (Abschnitt „Druckerdaten“).")
		return
	}
	if c.IP == "" {
		fail("Die IP-Adresse des Druckers ist unbekannt.")
		return
	}
	info := a.printer.Info()
	if info.State != "idle" && info.State != "done" {
		fail("Der Drucker ist gerade nicht bereit (" + info.Status + ").")
		return
	}

	path, err := a.downloadJob(job)
	if err != nil {
		fail("Download vom Server: " + err.Error())
		return
	}
	defer os.Remove(path)
	a.reportJob(job.ID, "sending", "Wird an den Drucker übertragen …")
	if err := ffUploadGcode(c.IP, c.FFSerial, c.FFCheckCode, path, jobFileName(job.Name), job.Leveling); err != nil {
		fail(err.Error())
		return
	}
	log.Printf("Druckauftrag „%s“ an den Drucker übergeben", job.Name)
	a.reportJob(job.ID, "printing", "Druck gestartet")
}

func (a *App) downloadJob(job *PrintJob) (string, error) {
	c := a.config()
	req, _ := http.NewRequest(http.MethodGet, serverBase(c.ServerURL)+job.URL, nil)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.ServerToken))
	resp, err := (&http.Client{Timeout: 30 * time.Minute}).Do(req)
	if err != nil {
		return "", errors.New("Server nicht erreichbar")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.CreateTemp("", "druckauftrag-*.gcode")
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, resp.Body)
	f.Close()
	if err != nil || (job.Size > 0 && n != job.Size) {
		os.Remove(f.Name())
		return "", errors.New("Download unvollständig")
	}
	return f.Name(), nil
}

// Port der HTTP-Schnittstelle des Druckers (in Tests änderbar)
var ffHTTPPort = "8898"

var unsafeFileRe = regexp.MustCompile(`[^A-Za-z0-9_\-]+`)

// jobFileName: Dateiname für den Drucker – nur einfache Zeichen (Umlaute/Leerzeichen mag nicht jede Firmware).
func jobFileName(name string) string {
	r := strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "Ä", "Ae", "Ö", "Oe", "Ü", "Ue", "ß", "ss", " ", "_")
	n := strings.Trim(unsafeFileRe.ReplaceAllString(r.Replace(name), "_"), "_")
	if n == "" {
		n = "druck"
	}
	if len(n) > 60 {
		n = n[:60]
	}
	return n + ".gcode"
}

func ffUploadGcode(host, serial, code, path, fileName string, leveling bool) error {
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	// Multipart mit fester Länge (keine "chunked"-Übertragung – das versteht nicht jede Firmware):
	// Kopf des Dateifelds + Datei + abschließende Grenze
	var head bytes.Buffer
	mw := multipart.NewWriter(&head)
	if _, err := mw.CreateFormFile("gcodeFile", fileName); err != nil {
		return err
	}
	tail := "\r\n--" + mw.Boundary() + "--\r\n"
	body := io.MultiReader(bytes.NewReader(head.Bytes()), f, strings.NewReader(tail))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+net.JoinHostPort(cleanHost(host), ffHTTPPort)+"/uploadGcode", body)
	req.ContentLength = int64(head.Len()) + st.Size() + int64(len(tail))
	req.Header.Set("Content-Type", mw.FormDataContentType())
	// Schreibweise genau wie in der Doku (Go würde sonst "Serialnumber" daraus machen)
	req.Header["serialNumber"] = []string{strings.TrimSpace(serial)}
	req.Header["checkCode"] = []string{strings.TrimSpace(code)}
	req.Header["fileSize"] = []string{strconv.FormatInt(st.Size(), 10)}
	req.Header["printNow"] = []string{"true"}
	req.Header["levelingBeforePrint"] = []string{strconv.FormatBool(leveling)}
	req.Header.Set("Expect", "100-continue")
	client := &http.Client{Transport: &http.Transport{ExpectContinueTimeout: 3 * time.Second, ResponseHeaderTimeout: 10 * time.Minute}}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("Drucker nicht erreichbar: " + friendlyErr(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	var r struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return fmt.Errorf("unerwartete Antwort des Druckers (HTTP %d)", resp.StatusCode)
	}
	switch r.Code {
	case 0:
		return nil
	case 1:
		return errors.New("Seriennummer oder Prüfcode falsch")
	case -2:
		return errors.New("LAN-Modus am Drucker ist nicht aktiviert")
	}
	return fmt.Errorf("Drucker lehnt die Datei ab (Fehler %d: %s)", r.Code, r.Message)
}
