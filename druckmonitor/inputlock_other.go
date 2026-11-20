//go:build !windows

package main

import "time"

const inputLockSupported = false

func platformLockInput(onSAS func()) error { return nil }
func platformUnlockInput()                 {}
func idleTime() time.Duration              { return 0 }
