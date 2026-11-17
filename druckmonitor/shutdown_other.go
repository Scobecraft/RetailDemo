//go:build !windows

package main

import "log"

func shutdownPC()      { log.Println("Herunterfahren nur unter Windows") }
func abortShutdownPC() {}
