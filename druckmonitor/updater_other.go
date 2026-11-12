//go:build !windows

package main

import "errors"

const updateSupported = false

func launchInstaller(path string) error { return errors.New("nur unter Windows") }
