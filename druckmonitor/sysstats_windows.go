//go:build windows

package main

// PC-Werte unter Windows:
//   - CPU gesamt, RAM, Laufwerke, Laufzeit: direkt über die Windows-API (schnell, immer verfügbar)
//   - Kerne, Netzwerk, Datenträger-Aktivität, GPU, Prozesse: Leistungsindikatoren über einen
//     dauerhaft laufenden, unsichtbaren PowerShell-Prozess (WMI-Klassen sind – anders als die
//     Indikatornamen – nicht übersetzt, funktionieren also auch auf deutschem Windows)
//   - NVIDIA-Karten zusätzlich über nvidia-smi (Temperatur, Leistung, Takt), falls vorhanden
//   - Hardware einmalig per PowerShell/WMI
// Alle Hilfsprozesse hängen an einem Job-Objekt und enden automatisch mit dem Druckmonitor.

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	pGetSystemTimes        = kernel32.NewProc("GetSystemTimes")
	pGlobalMemoryStatusEx  = kernel32.NewProc("GlobalMemoryStatusEx")
	pGetLogicalDrives      = kernel32.NewProc("GetLogicalDrives")
	pGetDriveTypeW         = kernel32.NewProc("GetDriveTypeW")
	pGetDiskFreeSpaceExW   = kernel32.NewProc("GetDiskFreeSpaceExW")
	pGetVolumeInformationW = kernel32.NewProc("GetVolumeInformationW")
	pGetTickCount64        = kernel32.NewProc("GetTickCount64")
	pCreateJobObjectW      = kernel32.NewProc("CreateJobObjectW")
	pSetInformationJob     = kernel32.NewProc("SetInformationJobObject")
	pAssignProcessToJob    = kernel32.NewProc("AssignProcessToJobObject")
	pGetCurrentProcess     = kernel32.NewProc("GetCurrentProcess")
)

const createNoWindow = 0x08000000

type winFiletime struct{ Low, High uint32 }

func (f winFiletime) u64() uint64 { return uint64(f.High)<<32 | uint64(f.Low) }

type memStatusEx struct {
	Length, MemoryLoad                                 uint32
	TotalPhys, AvailPhys, TotalPageFile, AvailPageFile uint64
	TotalVirtual, AvailVirtual, AvailExtendedVirtual   uint64
}

var jobOnce sync.Once

// Hilfsprozesse sollen mit dem Druckmonitor enden: eigenen Prozess in ein Job-Objekt mit
// "beim Schließen alle beenden" stecken – Kindprozesse erben die Mitgliedschaft.
func killChildrenOnExit() {
	jobOnce.Do(func() {
		job, _, _ := pCreateJobObjectW.Call(0, 0)
		if job == 0 {
			return
		}
		// JOBOBJECT_EXTENDED_LIMIT_INFORMATION (64 Bit): LimitFlags liegt bei Offset 16
		var info [144]byte
		binary.LittleEndian.PutUint32(info[16:], 0x2000) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		r, _, _ := pSetInformationJob.Call(job, 9, uintptr(unsafe.Pointer(&info[0])), uintptr(len(info)))
		if r == 0 {
			return
		}
		self, _, _ := pGetCurrentProcess.Call()
		pAssignProcessToJob.Call(job, self)
		// Handle bewusst offen lassen: Wird es beim Beenden geschlossen, endet auch der Rest.
	})
}

func hiddenCmd(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

// powershell startet ein Skript (als -EncodedCommand, damit keine Anführungszeichen-Probleme).
func powershell(script string) *exec.Cmd {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[i*2:], c)
	}
	return hiddenCmd("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", base64.StdEncoding.EncodeToString(b))
}

func (m *SysMonitor) run() {
	killChildrenOnExit()
	go m.collectInfo()
	perf := &perfReader{}
	go perf.run(m)
	nv := &nvReader{}
	go nv.run(m)

	var prevIdle, prevTotal uint64
	host, _ := os.Hostname()
	for {
		if !m.active() {
			time.Sleep(time.Second)
			continue
		}
		s := &PCStats{TS: time.Now().Unix(), Host: host, NetRxBps: -1, NetTxBps: -1, DiskRBps: -1, DiskWBps: -1, DiskBusy: -1}
		var idle, kern, user winFiletime
		if r, _, _ := pGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kern)), uintptr(unsafe.Pointer(&user))); r != 0 {
			total := kern.u64() + user.u64() // Kernel-Zeit enthält die Leerlaufzeit
			if prevTotal != 0 && total > prevTotal {
				s.CPUPct = clampPct(100 * (1 - float64(idle.u64()-prevIdle)/float64(total-prevTotal)))
			}
			prevIdle, prevTotal = idle.u64(), total
		}
		ms := memStatusEx{Length: uint32(unsafe.Sizeof(memStatusEx{}))}
		if r, _, _ := pGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms))); r != 0 {
			s.RAMTotalB, s.RAMUsedB = ms.TotalPhys, ms.TotalPhys-ms.AvailPhys
		}
		if t, _, _ := pGetTickCount64.Call(); t != 0 {
			s.UptimeSec = float64(t) / 1000
		}
		s.Disks = fixedDisks()
		perf.fill(s)
		nv.fill(s)
		m.setStats(s)
		time.Sleep(2 * time.Second)
	}
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func fixedDisks() []PCDisk {
	mask, _, _ := pGetLogicalDrives.Call()
	var out []PCDisk
	for i := 0; i < 26; i++ {
		if mask&(1<<i) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		p, _ := syscall.UTF16PtrFromString(root)
		if t, _, _ := pGetDriveTypeW.Call(uintptr(unsafe.Pointer(p))); t != 3 { // DRIVE_FIXED
			continue
		}
		var free, total, totalFree uint64
		r, _, _ := pGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&free)),
			uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&totalFree)))
		if r == 0 || total == 0 {
			continue
		}
		var label [261]uint16
		pGetVolumeInformationW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)), 0, 0, 0, 0, 0)
		out = append(out, PCDisk{Mount: root[:2], Label: syscall.UTF16ToString(label[:]), UsedB: total - totalFree, TotalB: total})
	}
	return out
}

// ---------------------------------------------------------------- Leistungsindikatoren (PowerShell)

const perfScript = `
$ErrorActionPreference = 'SilentlyContinue'
$parent = %d
while ($true) {
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
  $p = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' })
  $top = @($p | Sort-Object PercentProcessorTime -Descending | Select-Object -First 6) + @($p | Sort-Object WorkingSetPrivate -Descending | Select-Object -First 6)
  $o = @{
    cores = @(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | Select-Object Name, PercentProcessorUtility, PercentProcessorTime)
    net   = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object Name, BytesReceivedPersec, BytesSentPersec)
    disk  = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" | Select-Object DiskReadBytesPersec, DiskWriteBytesPersec, PercentIdleTime)
    gpu   = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.UtilizationPercentage -gt 0 } | Select-Object Name, UtilizationPercentage)
    vram  = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name, DedicatedUsage)
    procs = @($top | Select-Object Name, IDProcess, PercentProcessorTime, WorkingSetPrivate)
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 3))
  Start-Sleep -Seconds 2
}
`

type perfSample struct {
	Cores []struct {
		Name    jstr `json:"Name"`
		Utility jnum `json:"PercentProcessorUtility"`
		Time    jnum `json:"PercentProcessorTime"`
	} `json:"cores"`
	Net []struct {
		Name jstr `json:"Name"`
		Rx   jnum `json:"BytesReceivedPersec"`
		Tx   jnum `json:"BytesSentPersec"`
	} `json:"net"`
	Disk []struct {
		R    jnum `json:"DiskReadBytesPersec"`
		W    jnum `json:"DiskWriteBytesPersec"`
		Idle jnum `json:"PercentIdleTime"`
	} `json:"disk"`
	GPU []struct {
		Name jstr `json:"Name"`
		Pct  jnum `json:"UtilizationPercentage"`
	} `json:"gpu"`
	VRAM []struct {
		Name jstr `json:"Name"`
		Used jnum `json:"DedicatedUsage"`
	} `json:"vram"`
	Procs []struct {
		Name jstr `json:"Name"`
		PID  jnum `json:"IDProcess"`
		CPU  jnum `json:"PercentProcessorTime"`
		Mem  jnum `json:"WorkingSetPrivate"`
	} `json:"procs"`
}

type perfReader struct {
	mu   sync.Mutex
	last *perfSample
	at   time.Time
}

func (p *perfReader) run(m *SysMonitor) {
	for {
		for !m.active() {
			time.Sleep(2 * time.Second)
		}
		cmd := powershell(fmt.Sprintf(perfScript, os.Getpid()))
		out, err := cmd.StdoutPipe()
		if err == nil {
			err = cmd.Start()
		}
		if err != nil {
			log.Println("PC-Werte (PowerShell):", err)
			time.Sleep(time.Minute)
			continue
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 1<<20), 8<<20)
		for sc.Scan() {
			var s perfSample
			if json.Unmarshal(sc.Bytes(), &s) == nil {
				p.mu.Lock()
				p.last, p.at = &s, time.Now()
				p.mu.Unlock()
			}
			if !m.active() { // niemand fragt mehr: PowerShell beenden
				break
			}
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		time.Sleep(5 * time.Second)
	}
}

var gpuEngineRe = regexp.MustCompile(`luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_(\d+)_eng_(\d+)`)
var vramRe = regexp.MustCompile(`luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_(\d+)`)

func (p *perfReader) fill(s *PCStats) {
	p.mu.Lock()
	ps, at := p.last, p.at
	p.mu.Unlock()
	if ps == nil || time.Since(at) > 15*time.Second {
		return
	}
	// Kerne: Namen "0,0", "0,1", … (Gesamtwerte "_Total" bzw. "0,_Total" auslassen)
	type core struct {
		group, idx int
		pct        float64
	}
	var cores []core
	for _, c := range ps.Cores {
		parts := strings.Split(string(c.Name), ",")
		if len(parts) != 2 {
			continue
		}
		g, err1 := strconv.Atoi(parts[0])
		i, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil {
			continue
		}
		v := float64(c.Utility)
		if v == 0 {
			v = float64(c.Time)
		}
		cores = append(cores, core{g, i, clampPct(v)})
	}
	sort.Slice(cores, func(a, b int) bool {
		if cores[a].group != cores[b].group {
			return cores[a].group < cores[b].group
		}
		return cores[a].idx < cores[b].idx
	})
	for _, c := range cores {
		s.Cores = append(s.Cores, c.pct)
	}
	// Netzwerk: alle Adapter zusammen (virtuelle/Loopback-Adapter tauchen hier nicht auf)
	if len(ps.Net) > 0 {
		s.NetRxBps, s.NetTxBps = 0, 0
		for _, n := range ps.Net {
			s.NetRxBps += float64(n.Rx)
			s.NetTxBps += float64(n.Tx)
		}
	}
	if len(ps.Disk) > 0 {
		d := ps.Disk[0]
		s.DiskRBps, s.DiskWBps, s.DiskBusy = float64(d.R), float64(d.W), clampPct(100-float64(d.Idle))
	}
	// GPU-Auslastung wie im Task-Manager: je Grafikkarte die am stärksten ausgelastete Engine
	engines := map[string]float64{}
	for _, g := range ps.GPU {
		if m := gpuEngineRe.FindStringSubmatch(string(g.Name)); m != nil {
			engines[m[1]+"|"+m[2]+"|"+m[3]] += float64(g.Pct)
		}
	}
	perGPU := map[string]float64{}
	for k, v := range engines {
		id := k[:strings.LastIndex(k, "|")]
		if v > perGPU[id] {
			perGPU[id] = v
		}
	}
	vram := map[string]uint64{}
	for _, v := range ps.VRAM {
		if m := vramRe.FindStringSubmatch(string(v.Name)); m != nil {
			vram[m[1]+"|"+m[2]] = uint64(v.Used)
		}
	}
	// Die Grafikkarte mit dem meisten belegten Speicher ist meist die "richtige" (dedizierte)
	var bestID string
	for id, used := range vram {
		if bestID == "" || used > vram[bestID] {
			bestID = id
		}
	}
	if bestID != "" || len(perGPU) > 0 {
		pct := 0.0
		for id, v := range perGPU {
			if bestID == "" || id == bestID {
				pct = maxf(pct, v)
			}
		}
		s.GPUs = []PCGPU{{Pct: clampPct(pct), MemUsedB: vram[bestID], TempC: -1, PowerW: -1, FanPct: -1, ClockMHz: -1}}
	}
	// Prozesse: oberste nach CPU und nach Speicher (zusammengeführt, ohne Doppelte)
	threads := float64(len(cores))
	if threads == 0 {
		threads = 1
	}
	seen := map[int]bool{}
	for _, pr := range ps.Procs {
		pid := int(pr.PID)
		if seen[pid] {
			continue
		}
		seen[pid] = true
		s.Procs = append(s.Procs, PCProc{Name: procSuffixRe.ReplaceAllString(string(pr.Name), ""), CPUPct: clampPct(float64(pr.CPU) / threads), MemB: uint64(pr.Mem)})
	}
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// ---------------------------------------------------------------- NVIDIA (nvidia-smi)

type nvReader struct {
	mu   sync.Mutex
	gpus []PCGPU
	at   time.Time
}

func nvidiaSMI() string {
	if p, err := exec.LookPath("nvidia-smi.exe"); err == nil {
		return p
	}
	for _, p := range []string{os.Getenv("SystemRoot") + `\System32\nvidia-smi.exe`,
		os.Getenv("ProgramFiles") + `\NVIDIA Corporation\NVSMI\nvidia-smi.exe`} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func (n *nvReader) run(m *SysMonitor) {
	exe := nvidiaSMI()
	if exe == "" {
		return
	}
	for {
		for !m.active() {
			time.Sleep(2 * time.Second)
		}
		cmd := hiddenCmd(exe, "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed,clocks.gr",
			"--format=csv,noheader,nounits", "-l", "2")
		out, err := cmd.StdoutPipe()
		if err == nil {
			err = cmd.Start()
		}
		if err != nil {
			return
		}
		sc := bufio.NewScanner(out)
		var batch []PCGPU
		var batchAt time.Time
		for sc.Scan() {
			f := strings.Split(sc.Text(), ",")
			if len(f) < 8 {
				continue
			}
			val := func(i int) float64 {
				v, err := strconv.ParseFloat(strings.TrimSpace(f[i]), 64)
				if err != nil {
					return -1
				}
				return v
			}
			g := PCGPU{Name: strings.TrimSpace(f[0]), Pct: val(1), TempC: val(4), PowerW: val(5), FanPct: val(6), ClockMHz: val(7)}
			if v := val(2); v >= 0 {
				g.MemUsedB = uint64(v) << 20
			}
			if v := val(3); v >= 0 {
				g.MemTotalB = uint64(v) << 20
			}
			// Zeilen eines Durchgangs kommen direkt hintereinander
			if time.Since(batchAt) > time.Second {
				batch = nil
			}
			batch, batchAt = append(batch, g), time.Now()
			n.mu.Lock()
			n.gpus, n.at = append([]PCGPU(nil), batch...), time.Now()
			n.mu.Unlock()
			if !m.active() {
				break
			}
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		time.Sleep(5 * time.Second)
	}
}

func (n *nvReader) fill(s *PCStats) {
	n.mu.Lock()
	gpus, at := n.gpus, n.at
	n.mu.Unlock()
	if len(gpus) == 0 || time.Since(at) > 10*time.Second {
		return
	}
	s.GPUs = gpus // genauer als die Windows-Indikatoren
}

// ---------------------------------------------------------------- Hardware (einmalig)

const infoScript = `
$ErrorActionPreference = 'SilentlyContinue'
$o = @{
  cpu   = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed)
  cs    = @(Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, TotalPhysicalMemory)
  os    = @(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture)
  board = @(Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer, Product)
  bios  = @(Get-CimInstance Win32_BIOS | Select-Object SMBIOSBIOSVersion)
  mem   = @(Get-CimInstance Win32_PhysicalMemory | Select-Object DeviceLocator, Capacity, Speed, ConfiguredClockSpeed, Manufacturer, PartNumber)
  gpu   = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate, AdapterRAM)
  vram  = @(Get-ItemProperty 'HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' | Select-Object DriverDesc, @{n='Mem'; e={ $_.'HardwareInformation.qwMemorySize' }})
  disk  = @(Get-PhysicalDisk | Select-Object FriendlyName, @{n='Media'; e={ [string]$_.MediaType }}, @{n='Bus'; e={ [string]$_.BusType }}, Size)
  nic   = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object Name, InterfaceDescription, LinkSpeed)
}
[Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 3))
`

func (m *SysMonitor) collectInfo() {
	host, _ := os.Hostname()
	info := &PCInfo{Host: host}
	m.setInfo(info)
	out, err := powershell(infoScript).Output()
	if err != nil {
		log.Println("Hardware auslesen:", err)
		return
	}
	var raw struct {
		CPU   json.RawMessage `json:"cpu"`
		CS    json.RawMessage `json:"cs"`
		OS    json.RawMessage `json:"os"`
		Board json.RawMessage `json:"board"`
		BIOS  json.RawMessage `json:"bios"`
		Mem   json.RawMessage `json:"mem"`
		GPU   json.RawMessage `json:"gpu"`
		VRAM  json.RawMessage `json:"vram"`
		Disk  json.RawMessage `json:"disk"`
		NIC   json.RawMessage `json:"nic"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		log.Println("Hardware auslesen:", err)
		return
	}
	if c := list[struct {
		Name    jstr `json:"Name"`
		Cores   jnum `json:"NumberOfCores"`
		Threads jnum `json:"NumberOfLogicalProcessors"`
		MHz     jnum `json:"MaxClockSpeed"`
	}](raw.CPU); len(c) > 0 {
		info.CPU, info.CPUMaxMHz = cleanSpaces(string(c[0].Name)), int(c[0].MHz)
		for _, x := range c { // mehrere Prozessorsockel
			info.Cores += int(x.Cores)
			info.Threads += int(x.Threads)
		}
	}
	if c := list[struct {
		Maker jstr `json:"Manufacturer"`
		Model jstr `json:"Model"`
		RAM   jnum `json:"TotalPhysicalMemory"`
	}](raw.CS); len(c) > 0 {
		info.System = joinNonEmpty(" ", string(c[0].Maker), string(c[0].Model))
		info.RAMTotalB = uint64(c[0].RAM)
	}
	if o := list[struct {
		Caption jstr `json:"Caption"`
		Version jstr `json:"Version"`
		Build   jstr `json:"BuildNumber"`
		Arch    jstr `json:"OSArchitecture"`
	}](raw.OS); len(o) > 0 {
		info.OS = joinNonEmpty(" · ", strings.TrimPrefix(string(o[0].Caption), "Microsoft "), "Build "+string(o[0].Build), string(o[0].Arch))
	}
	if b := list[struct {
		Maker   jstr `json:"Manufacturer"`
		Product jstr `json:"Product"`
	}](raw.Board); len(b) > 0 {
		info.Board = joinNonEmpty(" ", string(b[0].Maker), string(b[0].Product))
	}
	if b := list[struct {
		Ver jstr `json:"SMBIOSBIOSVersion"`
	}](raw.BIOS); len(b) > 0 {
		info.BIOS = string(b[0].Ver)
	}
	var memSum uint64
	for _, mm := range list[struct {
		Slot  jstr `json:"DeviceLocator"`
		Cap   jnum `json:"Capacity"`
		Speed jnum `json:"Speed"`
		Conf  jnum `json:"ConfiguredClockSpeed"`
		Maker jstr `json:"Manufacturer"`
		Part  jstr `json:"PartNumber"`
	}](raw.Mem) {
		speed := int(mm.Conf)
		if speed == 0 {
			speed = int(mm.Speed)
		}
		info.RAMModules = append(info.RAMModules, PCRAMModule{Slot: string(mm.Slot), SizeB: uint64(mm.Cap), SpeedMHz: speed,
			Maker: string(mm.Maker), Part: string(mm.Part)})
		memSum += uint64(mm.Cap)
	}
	if memSum > 0 {
		info.RAMTotalB = memSum // verbaut (TotalPhysicalMemory zieht reservierten Speicher ab)
	}
	vram := map[string]uint64{}
	for _, v := range list[struct {
		Desc jstr `json:"DriverDesc"`
		Mem  jnum `json:"Mem"`
	}](raw.VRAM) {
		if v.Mem > 0 {
			vram[string(v.Desc)] = uint64(v.Mem)
		}
	}
	for _, g := range list[struct {
		Name    jstr `json:"Name"`
		Driver  jstr `json:"DriverVersion"`
		W       jnum `json:"CurrentHorizontalResolution"`
		H       jnum `json:"CurrentVerticalResolution"`
		Hz      jnum `json:"CurrentRefreshRate"`
		AdapRAM jnum `json:"AdapterRAM"`
	}](raw.GPU) {
		gi := PCInfoGPU{Name: string(g.Name), Driver: string(g.Driver), VRAMB: vram[string(g.Name)]}
		if gi.VRAMB == 0 && g.AdapRAM > 0 && g.AdapRAM < 4294967295 {
			gi.VRAMB = uint64(g.AdapRAM)
		}
		if g.W > 0 && g.H > 0 {
			gi.Display = fmt.Sprintf("%d × %d", int(g.W), int(g.H))
			if g.Hz > 1 {
				gi.Display += fmt.Sprintf(" · %d Hz", int(g.Hz))
			}
		}
		info.GPUs = append(info.GPUs, gi)
	}
	for _, d := range list[struct {
		Name  jstr `json:"FriendlyName"`
		Media jstr `json:"Media"`
		Bus   jstr `json:"Bus"`
		Size  jnum `json:"Size"`
	}](raw.Disk) {
		info.Disks = append(info.Disks, PCInfoDisk{Name: string(d.Name), Type: diskMedia(string(d.Media)), Bus: diskBus(string(d.Bus)), SizeB: uint64(d.Size)})
	}
	for _, n := range list[struct {
		Name  jstr `json:"Name"`
		Desc  jstr `json:"InterfaceDescription"`
		Speed jstr `json:"LinkSpeed"`
	}](raw.NIC) {
		info.NICs = append(info.NICs, PCInfoNIC{Name: joinNonEmpty(" – ", string(n.Desc), string(n.Name)), Speed: string(n.Speed)})
	}
	m.setInfo(info)
	log.Printf("Hardware erkannt: %s, %d GPU(s), %d Datenträger", info.CPU, len(info.GPUs), len(info.Disks))
}

func diskMedia(s string) string {
	switch s {
	case "3", "HDD":
		return "HDD"
	case "4", "SSD":
		return "SSD"
	case "5", "SCM":
		return "SCM"
	}
	return ""
}

func diskBus(s string) string {
	switch s {
	case "17", "NVMe":
		return "NVMe"
	case "11", "SATA":
		return "SATA"
	case "7", "USB":
		return "USB"
	case "8", "RAID":
		return "RAID"
	case "10", "SAS":
		return "SAS"
	case "12", "SD":
		return "SD"
	}
	return ""
}

func cleanSpaces(s string) string { return strings.Join(strings.Fields(s), " ") }

func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" && p != "Build " {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

var procSuffixRe = regexp.MustCompile(`#\d+$`)
