package main

import "testing"

// muss zu job_file_name im Server passen
func TestJobFileNameServerGleich(t *testing.T) {
	for in, want := range map[string]string{"Thing-Download – T-Form": "Thing-Download___T-Form.gcode", "Größe Würfel 2": "Groesse_Wuerfel_2.gcode"} {
		if got := jobFileName(in); got != want {
			t.Errorf("%q -> %q, erwartet %q", in, got, want)
		}
	}
}
