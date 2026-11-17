package main

import "testing"

func TestFillTimes(t *testing.T) {
	i := PrinterInfo{State: "printing", Progress: 0.25, RemainingSec: 0, ElapsedSec: 600}
	fillTimes(&i, FileMeta{TimeSec: 4000})
	if i.RemainingSec != 3000 || !i.RemainingEst {
		t.Fatalf("aus Slicer-Zeit: %+v", i)
	}
	i = PrinterInfo{State: "printing", Progress: 0.25, RemainingSec: 0, ElapsedSec: 600}
	fillTimes(&i, FileMeta{})
	if i.RemainingSec != 1800 {
		t.Fatalf("aus Drucktempo: %+v", i)
	}
	i = PrinterInfo{State: "printing", Progress: 0.25, RemainingSec: 1234}
	fillTimes(&i, FileMeta{TimeSec: 4000})
	if i.RemainingSec != 1234 || i.RemainingEst {
		t.Fatalf("Druckerangabe muss bleiben: %+v", i)
	}
	i = PrinterInfo{State: "printing", Progress: 0.001, RemainingSec: 0}
	fillTimes(&i, FileMeta{})
	if i.RemainingSec != -1 {
		t.Fatalf("unbekannt: %+v", i)
	}
}
