//go:build !darwin

package main

import "fmt"

func main() { fmt.Println("Mail Grid's detached Mac installer is only used on macOS.") }
