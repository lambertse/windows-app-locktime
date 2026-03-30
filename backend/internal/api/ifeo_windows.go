//go:build windows

package api

import (
	"log"
	"time"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
	"github.com/lambertse/windows-app-locktime/backend/internal/engine"
	"github.com/lambertse/windows-app-locktime/backend/internal/watcher"
)

// clearIFEOKey removes the IFEO Debugger value for the given exe name.
func clearIFEOKey(exeName string) {
	if err := watcher.ClearIFEO(exeName); err != nil {
		log.Printf("api: clearIFEOKey %s: %v", exeName, err)
	}
}

// reconcileIFEOForRule re-evaluates whether IFEO should be active for a rule
// based on its current enabled state and schedule, then sets or clears the key.
func reconcileIFEOForRule(s *Server, ruleID string) {
	rule, err := db.GetRuleByID(s.DB, ruleID)
	if err != nil || rule == nil {
		return
	}

	// Determine if the rule should currently be enforcing (i.e. locked)
	now := time.Now().UTC()
	todayMinutes, _ := db.GetDailyMinutes(s.DB, rule.ID, now.Format("2006-01-02"), now)
	rs, err := engine.ComputeRuleStatus(*rule, todayMinutes, now)
	if err != nil {
		return
	}

	// Get blocker path from config
	cfg, _ := db.GetConfig(s.DB)
	blockerPath := `C:\ProgramData\AppLocker\blocker.exe`
	if v, ok := cfg["blocker_exe_path"]; ok && v != "" {
		blockerPath = v
	}

	switch rs.Status {
	case "locked":
		// Should be enforcing — set IFEO if not already active
		if !rule.IFEOActive {
			if err := watcher.SetIFEO(rule.ExeName, blockerPath); err != nil {
				log.Printf("api: reconcileIFEO set %s: %v", rule.ExeName, err)
			} else {
				_ = db.SetRuleIFEOActive(s.DB, rule.ID, true)
			}
		}
	default:
		// Active or disabled — clear IFEO
		if rule.IFEOActive {
			if err := watcher.ClearIFEO(rule.ExeName); err != nil {
				log.Printf("api: reconcileIFEO clear %s: %v", rule.ExeName, err)
			} else {
				_ = db.SetRuleIFEOActive(s.DB, rule.ID, false)
			}
		}
	}
}
