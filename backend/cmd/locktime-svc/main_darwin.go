//go:build darwin

package main

import (
	"fmt"
	"log"
	"os"

	"github.com/lambertse/windows-app-locktime/backend/internal/service"
)

func main() {
	if len(os.Args) < 2 {
		if err := service.RunService(); err != nil {
			log.Fatalf("RunService: %v", err)
		}
		return
	}

	switch os.Args[1] {
	case "--run":
		if err := service.RunService(); err != nil {
			log.Fatalf("RunService: %v", err)
		}

	case "--install":
		exePath, err := os.Executable()
		if err != nil {
			log.Fatalf("get executable path: %v", err)
		}
		if err := service.Install(exePath); err != nil {
			log.Fatalf("Install: %v", err)
		}
		fmt.Println("Service installed successfully.")

	case "--uninstall":
		if err := service.Uninstall(); err != nil {
			log.Fatalf("Uninstall: %v", err)
		}
		fmt.Println("Service uninstalled successfully.")

	default:
		fmt.Fprintf(os.Stderr, "Usage: %s [--install|--uninstall|--run]\n", os.Args[0])
		os.Exit(1)
	}
}
