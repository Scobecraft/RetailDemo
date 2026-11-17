package main

import "log"

func shutdownPC() {
	// 60 s Vorwarnung von Windows; im Monitor lässt sich noch abbrechen („Heute nicht“)
	if err := hiddenCmd("shutdown", "/s", "/t", "60", "/c", "Druckmonitor: Feierabend – der PC fährt in einer Minute herunter.").Run(); err != nil {
		log.Println("Herunterfahren fehlgeschlagen:", err)
	}
}

func abortShutdownPC() { _ = hiddenCmd("shutdown", "/a").Run() }
