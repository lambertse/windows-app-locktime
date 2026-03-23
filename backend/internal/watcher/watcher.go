//go:build windows

package watcher

import (
	"database/sql"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
)

const (
	TH32CS_SNAPPROCESS = 0x00000002
	PROCESS_ALL_ACCESS  = 0x1F0FFF
	PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
)

// ProcessInfo holds information about a running process.
type ProcessInfo struct {
	PID      int    `json:"pid"`
	Name     string `json:"name"`
	FullPath string `json:"full_path"`
}

// activeSession tracks an open usage session for a process.
type activeSession struct {
	sessionID int64
	pid       int
	startedAt time.Time
}

// Watcher polls running processes and enforces rules.
type Watcher struct {
	database *sql.DB
	mu       sync.Mutex
	sessions map[string]*activeSession // ruleID -> active session
	stopCh   chan struct{}
}

// New creates a new Watcher.
func New(database *sql.DB) *Watcher {
	return &Watcher{
		database: database,
		sessions: make(map[string]*activeSession),
		stopCh:   make(chan struct{}),
	}
}

// Start begins the polling loop.
func (w *Watcher) Start() {
	go w.loop()
}

// Stop halts the watcher.
func (w *Watcher) Stop() {
	close(w.stopCh)
}

func (w *Watcher) loop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-w.stopCh:
			return
		case <-ticker.C:
			w.tick()
		}
	}
}

func (w *Watcher) tick() {
	procs, err := SnapshotProcesses()
	if err != nil {
		log.Printf("watcher: snapshot error: %v", err)
		return
	}

	rules, err := db.GetRules(w.database)
	if err != nil {
		log.Printf("watcher: get rules error: %v", err)
		return
	}

	// Build PID set for quick lookup
	pidSet := make(map[int]ProcessInfo)
	for _, p := range procs {
		pidSet[p.PID] = p
	}

	now := time.Now().UTC()

	w.mu.Lock()
	defer w.mu.Unlock()

	for _, rule := range rules {
		if !rule.Enabled {
			// Close any open session if rule was disabled
			if sess, ok := w.sessions[rule.ID]; ok {
				_ = db.CloseUsageSession(w.database, sess.sessionID, now, "natural")
				delete(w.sessions, rule.ID)
			}
			continue
		}

		matchingProc := findMatchingProcess(rule, procs)

		if matchingProc != nil {
			// Process is running
			if sess, ok := w.sessions[rule.ID]; ok {
				// Existing session — check if PID changed (new launch)
				if sess.pid != matchingProc.PID {
					_ = db.CloseUsageSession(w.database, sess.sessionID, now, "natural")
					delete(w.sessions, rule.ID)
					w.openSession(rule.ID, matchingProc.PID, now)
				}
				// else heartbeat — session continues
			} else {
				// New session
				w.openSession(rule.ID, matchingProc.PID, now)
			}
		} else {
			// Process not running
			if sess, ok := w.sessions[rule.ID]; ok {
				_ = db.CloseUsageSession(w.database, sess.sessionID, now, "natural")
				delete(w.sessions, rule.ID)
			}
		}
	}
}

func (w *Watcher) openSession(ruleID string, pid int, now time.Time) {
	sessionID, err := db.OpenUsageSession(w.database, ruleID, pid, now)
	if err != nil {
		log.Printf("watcher: open session error for rule %s: %v", ruleID, err)
		return
	}
	w.sessions[ruleID] = &activeSession{
		sessionID: sessionID,
		pid:       pid,
		startedAt: now,
	}
}

// findMatchingProcess finds a running process matching the rule's match_mode criteria.
func findMatchingProcess(rule db.Rule, procs []ProcessInfo) *ProcessInfo {
	for i := range procs {
		p := &procs[i]
		switch rule.MatchMode {
		case "path":
			if rule.ExePath != nil && strings.EqualFold(p.FullPath, *rule.ExePath) {
				return p
			}
		default: // "name"
			if strings.EqualFold(p.Name, rule.ExeName) {
				return p
			}
		}
	}
	return nil
}

// GetActiveSessions returns current active sessions (caller holds no lock — safe read).
func (w *Watcher) GetActiveSessions() map[string]*activeSession {
	w.mu.Lock()
	defer w.mu.Unlock()
	result := make(map[string]*activeSession, len(w.sessions))
	for k, v := range w.sessions {
		cp := *v
		result[k] = &cp
	}
	return result
}

// GetActiveSessionForRule returns the active session for a given rule, if any.
func (w *Watcher) GetActiveSessionForRule(ruleID string) *activeSession {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s, ok := w.sessions[ruleID]; ok {
		cp := *s
		return &cp
	}
	return nil
}

// CloseAllSessions closes all tracked sessions (called on graceful shutdown).
func (w *Watcher) CloseAllSessions(reason string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now().UTC()
	for ruleID, sess := range w.sessions {
		_ = db.CloseUsageSession(w.database, sess.sessionID, now, reason)
		delete(w.sessions, ruleID)
	}
}

// ─────────────────────────────────────────
// Windows API: process enumeration
// ─────────────────────────────────────────

// PROCESSENTRY32 matches the Windows struct layout.
type PROCESSENTRY32 struct {
	Size              uint32
	CntUsage          uint32
	ProcessID         uint32
	DefaultHeapID     uintptr
	ModuleID          uint32
	CntThreads        uint32
	ParentProcessID   uint32
	PriClassBase      int32
	Flags             uint32
	ExeFile           [260]uint16
}

var (
	kernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procCreateToolhelp32Snapshot = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW          = kernel32.NewProc("Process32FirstW")
	procProcess32NextW           = kernel32.NewProc("Process32NextW")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
)

// SnapshotProcesses returns a list of currently running processes with full paths.
func SnapshotProcesses() ([]ProcessInfo, error) {
	handle, _, err := procCreateToolhelp32Snapshot.Call(TH32CS_SNAPPROCESS, 0)
	if handle == uintptr(windows.InvalidHandle) {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(windows.Handle(handle))

	var entry PROCESSENTRY32
	entry.Size = uint32(unsafe.Sizeof(entry))

	ret, _, err := procProcess32FirstW.Call(handle, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return nil, fmt.Errorf("Process32FirstW: %w", err)
	}

	var procs []ProcessInfo
	for {
		name := windows.UTF16ToString(entry.ExeFile[:])
		fullPath := QueryFullProcessImageName(int(entry.ProcessID))

		procs = append(procs, ProcessInfo{
			PID:      int(entry.ProcessID),
			Name:     name,
			FullPath: fullPath,
		})

		ret, _, _ = procProcess32NextW.Call(handle, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}
	return procs, nil
}

// QueryFullProcessImageName returns the full path of a process by PID.
// Returns empty string on failure (e.g., access denied).
func QueryFullProcessImageName(pid int) string {
	handle, err := windows.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)

	var buf [windows.MAX_PATH]uint16
	size := uint32(len(buf))
	ret, _, _ := procQueryFullProcessImageNameW.Call(
		uintptr(handle),
		0,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret == 0 {
		return ""
	}
	return windows.UTF16ToString(buf[:size])
}

// TerminateProcess forcibly kills a process by PID.
func TerminateProcess(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("OpenProcess pid=%d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)
	return windows.TerminateProcess(handle, 1)
}

// ─────────────────────────────────────────
// IFEO registry management
// ─────────────────────────────────────────

const ifeoBase = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options`

// SetIFEO sets the Debugger key for exeName to point to blockerExePath.
// Refuses to set IFEO on blocker.exe itself.
func SetIFEO(exeName, blockerExePath string) error {
	if strings.EqualFold(filepath.Base(exeName), "blocker.exe") {
		return fmt.Errorf("refusing to register blocker.exe as IFEO target")
	}

	keyPath := ifeoBase + `\` + exeName
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, keyPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("CreateKey %s: %w", keyPath, err)
	}
	defer k.Close()

	return k.SetStringValue("Debugger", blockerExePath)
}

// ClearIFEO removes the Debugger value (and the key if empty) for exeName.
func ClearIFEO(exeName string) error {
	keyPath := ifeoBase + `\` + exeName
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, keyPath, registry.SET_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			return nil // Already gone
		}
		return fmt.Errorf("OpenKey %s: %w", keyPath, err)
	}
	defer k.Close()

	if err := k.DeleteValue("Debugger"); err != nil && err != registry.ErrNotExist {
		return fmt.Errorf("DeleteValue Debugger: %w", err)
	}
	return nil
}

// ReconcileIFEO ensures IFEO keys match the ifeo_active state in the DB.
func ReconcileIFEO(database *sql.DB, blockerExePath string) {
	rules, err := db.GetRules(database)
	if err != nil {
		log.Printf("ifeo reconcile: get rules: %v", err)
		return
	}
	for _, rule := range rules {
		if !rule.Enabled {
			if rule.IFEOActive {
				if err := ClearIFEO(rule.ExeName); err != nil {
					log.Printf("ifeo reconcile clear %s: %v", rule.ExeName, err)
				} else {
					_ = db.SetRuleIFEOActive(database, rule.ID, false)
				}
			}
			continue
		}
		if rule.IFEOActive {
			// Ensure key exists
			if err := SetIFEO(rule.ExeName, blockerExePath); err != nil {
				log.Printf("ifeo reconcile set %s: %v", rule.ExeName, err)
			}
		}
	}
}
