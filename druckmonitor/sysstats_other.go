//go:build !windows

package main

// PC-Werte unter Linux (zum Testen; im Laden läuft der Druckmonitor unter Windows).

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func (m *SysMonitor) run() {
	host, _ := os.Hostname()
	m.setInfo(linuxInfo(host))
	var prevIdle, prevTotal []uint64
	var prevRx, prevTx, prevR, prevW uint64
	var prevAt time.Time
	for {
		if !m.active() {
			time.Sleep(time.Second)
			continue
		}
		s := &PCStats{TS: time.Now().Unix(), Host: host, NetRxBps: -1, NetTxBps: -1, DiskRBps: -1, DiskWBps: -1, DiskBusy: -1}
		idle, total := cpuTimes()
		if len(prevTotal) == len(total) && len(total) > 0 {
			pct := func(i int) float64 {
				dt := float64(total[i] - prevTotal[i])
				if dt <= 0 {
					return 0
				}
				return clampPct(100 * (1 - float64(idle[i]-prevIdle[i])/dt))
			}
			s.CPUPct = pct(0)
			for i := 1; i < len(total); i++ {
				s.Cores = append(s.Cores, pct(i))
			}
		}
		prevIdle, prevTotal = idle, total
		if mi := meminfo(); mi["MemTotal"] > 0 {
			s.RAMTotalB = mi["MemTotal"] * 1024
			s.RAMUsedB = (mi["MemTotal"] - mi["MemAvailable"]) * 1024
		}
		if b, err := os.ReadFile("/proc/uptime"); err == nil {
			s.UptimeSec, _ = strconv.ParseFloat(strings.Fields(string(b))[0], 64)
		}
		var st syscall.Statfs_t
		if syscall.Statfs("/", &st) == nil {
			total := st.Blocks * uint64(st.Bsize)
			s.Disks = []PCDisk{{Mount: "/", UsedB: total - st.Bfree*uint64(st.Bsize), TotalB: total}}
		}
		rx, tx := netBytes()
		r, w := diskBytes()
		now := time.Now()
		if !prevAt.IsZero() {
			dt := now.Sub(prevAt).Seconds()
			s.NetRxBps, s.NetTxBps = float64(rx-prevRx)/dt, float64(tx-prevTx)/dt
			s.DiskRBps, s.DiskWBps = float64(r-prevR)/dt, float64(w-prevW)/dt
		}
		prevRx, prevTx, prevR, prevW, prevAt = rx, tx, r, w, now
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

func cpuTimes() (idle, total []uint64) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fl := strings.Fields(sc.Text())
		if len(fl) < 5 || !strings.HasPrefix(fl[0], "cpu") {
			continue
		}
		var t uint64
		for i, v := range fl[1:] {
			n, _ := strconv.ParseUint(v, 10, 64)
			t += n
			if i == 3 {
				idle = append(idle, n)
			}
		}
		total = append(total, t)
	}
	return
}

func meminfo() map[string]uint64 {
	out := map[string]uint64{}
	b, _ := os.ReadFile("/proc/meminfo")
	for _, l := range strings.Split(string(b), "\n") {
		if k, v, ok := strings.Cut(l, ":"); ok {
			n, _ := strconv.ParseUint(strings.Fields(v + " 0")[0], 10, 64)
			out[k] = n
		}
	}
	return out
}

func netBytes() (rx, tx uint64) {
	b, _ := os.ReadFile("/proc/net/dev")
	for _, l := range strings.Split(string(b), "\n")[2:] {
		name, rest, ok := strings.Cut(l, ":")
		if !ok || strings.TrimSpace(name) == "lo" {
			continue
		}
		f := strings.Fields(rest)
		if len(f) >= 9 {
			r, _ := strconv.ParseUint(f[0], 10, 64)
			t, _ := strconv.ParseUint(f[8], 10, 64)
			rx += r
			tx += t
		}
	}
	return
}

func diskBytes() (r, w uint64) {
	b, _ := os.ReadFile("/proc/diskstats")
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) < 10 || strings.HasPrefix(f[2], "loop") || strings.HasPrefix(f[2], "ram") {
			continue
		}
		rs, _ := strconv.ParseUint(f[5], 10, 64)
		ws, _ := strconv.ParseUint(f[9], 10, 64)
		r += rs * 512
		w += ws * 512
	}
	return
}

func linuxInfo(host string) *PCInfo {
	info := &PCInfo{Host: host, OS: "Linux"}
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(l, "PRETTY_NAME="); ok {
				info.OS = strings.Trim(v, `"`)
			}
		}
	}
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		cores := map[string]bool{}
		for _, l := range strings.Split(string(b), "\n") {
			k, v, _ := strings.Cut(l, ":")
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			switch k {
			case "model name":
				info.CPU = v
			case "processor":
				info.Threads++
			case "core id":
				cores[v] = true
			}
		}
		info.Cores = len(cores)
		if info.Cores == 0 {
			info.Cores = info.Threads
		}
	}
	info.RAMTotalB = meminfo()["MemTotal"] * 1024
	return info
}
