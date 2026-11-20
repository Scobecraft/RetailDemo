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
	Dispatch int64  `json:"dispatch"` // jedes Abschicken eigene Nummer (derselbe Auftrag darf mehrmals gedruckt werden)
}

var (
	printJobsMu   sync.Mutex
	printJobsSeen = map[string]bool{}
)

// onPrintJob wird nach jeder Übertragung aufgerufen; jedes Abschicken nur einmal bearbeiten.
// Früher galt das je Auftrag für immer – ein zweiter Druck desselben Auftrags blieb dann bis zum
// Neustart der App liegen. Jetzt zählt die Nummer des Abschickens (bzw. bei älteren Servern: nur
// solange der Auftrag gerade bearbeitet wird).
func (a *App) onPrintJob(job *PrintJob) {
	if job == nil || job.ID == "" {
		return
	}
	key := job.ID + "@" + strconv.FormatInt(job.Dispatch, 10)
	printJobsMu.Lock()
	if printJobsSeen[key] {
		printJobsMu.Unlock()
		return
	}
	printJobsSeen[key] = true
	printJobsMu.Unlock()
	go func() {
		a.runPrintJob(job)
		if job.Dispatch == 0 { // alter Server ohne Nummer: nach kurzer Pause wieder annehmen
			time.Sleep(2 * time.Minute)
			printJobsMu.Lock()
			delete(printJobsSeen, key)
			printJobsMu.Unlock()
		}
	}()
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
	if info.State == "done" {
		// Druck fertig: neuere Firmware will erst „Druckplatte geräumt“ – das hat der Nutzer auf der Webseite bestätigt
		ffClearPlatform(c.IP, c.FFSerial, c.FFCheckCode)
		time.Sleep(3 * time.Second)
		info = a.printer.Info()
	}
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
	err = ffUploadGcode(c.IP, c.FFSerial, c.FFCheckCode, path, jobFileName(job.Name), job.Leveling)
	if err != nil {
		// zweiter Versuch: Druckplatte am Drucker als geräumt melden, kurz warten, nochmal
		log.Printf("Druckauftrag „%s“: erster Versuch fehlgeschlagen (%v) – nochmal", job.Name, err)
		ffClearPlatform(c.IP, c.FFSerial, c.FFCheckCode)
		time.Sleep(4 * time.Second)
		err = ffUploadGcode(c.IP, c.FFSerial, c.FFCheckCode, path, jobFileName(job.Name), job.Leveling)
	}
	if err != nil {
		fail(err.Error())
		return
	}
	log.Printf("Druckauftrag „%s“ an den Drucker übergeben", job.Name)
	a.reportJob(job.ID, "printing", "Druck gestartet")
	// Die Datei liegt nicht auf dem PC (die automatische Suche fände sie nicht) –
	// deshalb gleich als aktuelles Modell übernehmen: Vorschau, Slicer-Angaben, Webseite.
	if f, err := os.Open(path); err == nil {
		err = a.storeModel(job.Name+".gcode", f, "von der Retail-Demo-Webseite")
		f.Close()
		log.Printf("Modell „%s“ aus dem Druckauftrag übernommen: %v", job.Name, err)
	}
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
	// keine offen bleibende Verbindung: der Drucker verkraftet nur wenige gleichzeitig
	client := &http.Client{Transport: &http.Transport{Proxy: nil, ExpectContinueTimeout: 3 * time.Second,
		ResponseHeaderTimeout: 10 * time.Minute, DisableKeepAlives: true}}
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

// ffClearPlatform meldet dem Drucker „Druckplatte geräumt“ (HTTP-Schnittstelle, /control). Neuere Firmware
// nimmt nach einem fertigen Druck erst danach einen neuen Auftrag an. Fehler sind egal (ältere Firmware kennt es nicht).
func ffClearPlatform(host, serial, code string) {
	if strings.TrimSpace(serial) == "" || strings.TrimSpace(code) == "" || host == "" {
		return
	}
	body, _ := json.Marshal(map[string]any{
		"serialNumber": strings.TrimSpace(serial), "checkCode": strings.TrimSpace(code),
		"payload": map[string]any{"cmd": "stateCtrl_cmd", "args": map[string]string{"action": "setClearPlatform"}},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+net.JoinHostPort(cleanHost(host), ffHTTPPort)+"/control", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := newClient().Do(req)
	if err != nil {
		log.Println("Druckplatte geräumt melden:", friendlyErr(err))
		return
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	log.Printf("Druckplatte geräumt gemeldet: HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(raw)))
}

var clearPlatformSeen int64

// onClearPlatform: auf der Webseite wurde „Druckbett ist frei“ bestätigt → auch am Drucker melden.
func (a *App) onClearPlatform(seq int64) {
	printJobsMu.Lock()
	if seq == 0 || seq == clearPlatformSeen {
		printJobsMu.Unlock()
		return
	}
	first := clearPlatformSeen == 0
	clearPlatformSeen = seq
	printJobsMu.Unlock()
	if first && time.Since(time.UnixMilli(seq)) > 10*time.Minute {
		return // alte Bestätigung von vor dem Programmstart
	}
	c := a.config()
	go ffClearPlatform(c.IP, c.FFSerial, c.FFCheckCode)
}

// ModelOverride: Auf der Webseite hochgeladenes (oder aus dem 3D-Slicer gewähltes) Modell – für den Fall,
// dass die automatische Suche die Druckdatei auf dem PC nicht findet.
type ModelOverride struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

var modelOverrideBusy sync.Mutex

func (a *App) onModelOverride(m *ModelOverride) {
	if m == nil || m.ID == "" || m.ID == a.config().HandledModel || !modelOverrideBusy.TryLock() {
		return
	}
	go func() {
		defer modelOverrideBusy.Unlock()
		f, err := os.CreateTemp("", "modell-*")
		if err != nil {
			return
		}
		defer os.Remove(f.Name())
		c := a.config()
		req, _ := http.NewRequest(http.MethodGet, serverBase(c.ServerURL)+m.URL, nil)
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.ServerToken))
		resp, err := (&http.Client{Timeout: 10 * time.Minute}).Do(req)
		if err != nil {
			f.Close()
			log.Println("Modell von der Webseite laden:", err)
			return
		}
		_, err = io.Copy(f, resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK {
			f.Close()
			log.Println("Modell von der Webseite laden: HTTP", resp.StatusCode, err)
			return
		}
		f.Seek(0, io.SeekStart)
		err = a.storeModel(m.Name, f, "von der Webseite hochgeladen")
		f.Close()
		log.Printf("Modell „%s“ von der Webseite übernommen: %v", m.Name, err)
		a.mu.Lock()
		a.cfg.HandledModel = m.ID
		cfg := a.cfg
		a.mu.Unlock()
		_ = a.saveConfig(cfg)
	}()
}
