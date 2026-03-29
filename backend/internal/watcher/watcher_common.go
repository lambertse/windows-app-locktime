package watcher

import (
	"database/sql"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
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
	procs, err := snapshotProcesses() // platform-specific
	if err != nil {
		log.Printf("watcher: snapshot error: %v", err)
		return
	}

	rules, err := db.GetRules(w.database)
	if err != nil {
		log.Printf("watcher: get rules error: %v", err)
		return
	}

	now := time.Now().UTC()

	w.mu.Lock()
	defer w.mu.Unlock()

	for _, rule := range rules {
		if !rule.Enabled {
			if sess, ok := w.sessions[rule.ID]; ok {
				_ = db.CloseUsageSession(w.database, sess.sessionID, now, "natural")
				delete(w.sessions, rule.ID)
			}
			continue
		}

		matchingProc := findMatchingProcess(rule, procs)

		if matchingProc != nil {
			// Platform-specific enforcement (no-op on Windows; SIGTERM on macOS).
			enforceRule(rule, matchingProc, w.database, now)

			if sess, ok := w.sessions[rule.ID]; ok {
				if sess.pid != matchingProc.PID {
					// New launch of same app — rotate session.
					_ = db.CloseUsageSession(w.database, sess.sessionID, now, "natural")
					delete(w.sessions, rule.ID)
					w.openSession(rule.ID, matchingProc.PID, now)
				}
				// else: heartbeat — session continues
			} else {
				w.openSession(rule.ID, matchingProc.PID, now)
			}
		} else {
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

// GetActiveSessions returns a snapshot of current active sessions.
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
