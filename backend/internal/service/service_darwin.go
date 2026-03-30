//go:build darwin

package service

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"text/template"
	"time"

	"github.com/lambertse/windows-app-locktime/backend/internal/api"
	"github.com/lambertse/windows-app-locktime/backend/internal/db"
	"github.com/lambertse/windows-app-locktime/backend/internal/watcher"
)

const (
	ServiceLabel   = "com.lambertse.applocker"
	DBPath         = "/Library/Application Support/AppLocker/applocker.db"
	ListenAddr     = "127.0.0.1:8089"
	FrontendAddr   = "127.0.0.1:8090"
	PlistPath      = "/Library/LaunchDaemons/com.lambertse.applocker.plist"
	LogDir         = "/var/log/applocker"
	installHtmlDir = "/usr/local/share/applocker/html"
)

// htmlDir returns the frontend dist directory. When installed via .pkg the
// files live at the fixed system path; during local development they are
// expected next to the binary.
func htmlDir() string {
	if _, err := os.Stat(installHtmlDir); err == nil {
		return installHtmlDir
	}
	exePath, _ := os.Executable()
	return filepath.Join(filepath.Dir(exePath), "html")
}

const launchdPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.lambertse.applocker</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{.ExePath}}</string>
		<string>--run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/var/log/applocker/applocker.log</string>
	<key>StandardErrorPath</key>
	<string>/var/log/applocker/applocker.error.log</string>
</dict>
</plist>
`

// RunService starts the API server, SPA server, and process watcher, then
// blocks until SIGTERM or SIGINT is received (managed by launchd or the user).
func RunService() error {
	startedAt := time.Now()

	if err := os.MkdirAll(filepath.Dir(DBPath), 0750); err != nil {
		return fmt.Errorf("mkdir db dir: %w", err)
	}

	database, err := db.Open(DBPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer database.Close()

	if err := db.CrashRecovery(database, startedAt); err != nil {
		log.Printf("service: crash recovery: %v", err)
	}

	// Start API server (8089).
	apiServer := &api.Server{DB: database, StartedAt: startedAt}
	apiRouter := api.SetupRouter(apiServer)
	go func() {
		if err := apiRouter.Run(ListenAddr); err != nil {
			log.Printf("service: api server: %v", err)
		}
	}()

	// Start Go SPA server (8090).
	frontendRouter := api.NewFrontendRouter(htmlDir())
	go func() {
		if err := frontendRouter.Run(FrontendAddr); err != nil {
			log.Printf("service: frontend server: %v", err)
		}
	}()

	// Start process watcher.
	w := watcher.New(database)
	w.Start()

	log.Printf("service: applocker started (api=%s frontend=%s)", ListenAddr, FrontendAddr)

	// Block until the OS or launchd sends a stop signal.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	<-ctx.Done()

	log.Printf("service: shutting down")
	w.CloseAllSessions("natural")
	return nil
}

// Install writes the LaunchDaemon plist and loads it via launchctl.
// Must be run as root.
func Install(exePath string) error {
	if err := os.MkdirAll(LogDir, 0755); err != nil {
		return fmt.Errorf("mkdir log dir: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(PlistPath), 0755); err != nil {
		return fmt.Errorf("mkdir plist dir: %w", err)
	}

	f, err := os.Create(PlistPath)
	if err != nil {
		return fmt.Errorf("create plist: %w", err)
	}
	defer f.Close()

	tmpl, err := template.New("plist").Parse(launchdPlist)
	if err != nil {
		return fmt.Errorf("parse plist template: %w", err)
	}
	if err := tmpl.Execute(f, map[string]string{"ExePath": exePath}); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	if out, err := exec.Command("launchctl", "bootstrap", "system", PlistPath).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
	}

	return nil
}

// Uninstall unloads and removes the LaunchDaemon. Must be run as root.
func Uninstall() error {
	// Best-effort unload; ignore error if already unloaded.
	_ = exec.Command("launchctl", "bootout", "system", PlistPath).Run()

	if err := os.Remove(PlistPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove plist: %w", err)
	}
	return nil
}
