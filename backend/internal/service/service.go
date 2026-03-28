//go:build windows

package service

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/lambertse/windows-app-locktime/backend/internal/api"
	"github.com/lambertse/windows-app-locktime/backend/internal/db"
	"github.com/lambertse/windows-app-locktime/backend/internal/frontend"
	"github.com/lambertse/windows-app-locktime/backend/internal/watcher"
)

const (
	ServiceName    = "LockTimeSvc"
	ServiceDisplay = "LockTime Application Guard"
	DBPath         = `C:\ProgramData\locktime\locktime.db`
	ListenAddr     = "127.0.0.1:8089" // API only
	FrontendAddr   = "127.0.0.1:8090" // embedded SPA
)

// LockTimeHandler implements svc.Handler.
type LockTimeHandler struct{}

// Execute is called by the Windows SCM when the service starts.
func (h *LockTimeHandler) Execute(args []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (svcSpecificEC bool, exitCode uint32) {
	s <- svc.Status{State: svc.StartPending}

	startedAt := time.Now()

	// Ensure DB directory exists
	if err := os.MkdirAll(filepath.Dir(DBPath), 0750); err != nil {
		log.Printf("service: mkdir: %v", err)
		return true, 1
	}

	// Open database
	database, err := db.Open(DBPath)
	if err != nil {
		log.Printf("service: open db: %v", err)
		return true, 1
	}

	// Crash recovery: close open sessions from previous run
	if err := db.CrashRecovery(database, startedAt); err != nil {
		log.Printf("service: crash recovery: %v", err)
	}

	// Start API server (8089) — no embedded frontend, API routes only.
	apiServer := &api.Server{
		DB:        database,
		StartedAt: startedAt,
	}
	apiRouter := api.SetupRouter(apiServer)
	go func() {
		if err := apiRouter.Run(ListenAddr); err != nil {
			log.Printf("service: api server: %v", err)
		}
	}()

	// Start frontend server (8090) — serves embedded SPA, no API routes.
	frontendRouter := api.NewFrontendRouter(frontend.FS())
	go func() {
		if err := frontendRouter.Run(FrontendAddr); err != nil {
			log.Printf("service: frontend server: %v", err)
		}
	}()

	// Get blocker path from config
	cfg, _ := db.GetConfig(database)
	blockerPath := `C:\ProgramData\locktime\blocker.exe`
	if v, ok := cfg["blocker_exe_path"]; ok && v != "" {
		blockerPath = v
	}

	// Reconcile IFEO keys
	watcher.ReconcileIFEO(database, blockerPath)

	// Start process watcher
	w := watcher.New(database)
	w.Start()

	// Log service start
	action := "service_start"
	detail := fmt.Sprintf(`{"startup_time":"%s"}`, startedAt.UTC().Format(time.RFC3339))
	_ = db.InsertAuditLog(database, action, nil, &detail)

	s <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}

	// Wait for SCM signals
	for cr := range r {
		switch cr.Cmd {
		case svc.Stop, svc.Shutdown:
			s <- svc.Status{State: svc.StopPending}
			w.CloseAllSessions("natural")
			action := "service_stop"
			_ = db.InsertAuditLog(database, action, nil, nil)
			return false, 0
		case svc.Interrogate:
			s <- cr.CurrentStatus
		}
	}

	return false, 0
}

// RunService runs the Windows service.
func RunService() error {
	return svc.Run(ServiceName, &LockTimeHandler{})
}

// Install installs the service via SCM.
func Install(exePath string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err == nil {
		s.Close()
		return fmt.Errorf("service %s already installed", ServiceName)
	}

	s, err = m.CreateService(ServiceName, exePath, mgr.Config{
		DisplayName:  ServiceDisplay,
		Description:  "Enforces time-based access restrictions on applications.",
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, "--run")
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	// Set recovery actions: restart on first, second, and subsequent failures
	err = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}, 60)
	if err != nil {
		log.Printf("install: set recovery actions: %v", err)
	}

	return nil
}

// Uninstall stops and removes the service.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()

	// Clear all IFEO keys before uninstalling
	database, err := db.Open(DBPath)
	if err == nil {
		rules, _ := db.GetRules(database)
		for _, rule := range rules {
			if rule.IFEOActive {
				_ = watcher.ClearIFEO(rule.ExeName)
			}
		}
		database.Close()
	}

	return s.Delete()
}
