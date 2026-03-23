package engine

import (
	"fmt"
	"time"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
)

// RuleStatus represents computed enforcement status for a rule.
type RuleStatus struct {
	Status      string  // "locked" | "active" | "disabled"
	Reason      *string // "outside_schedule" | "daily_limit_reached" | "both" | nil
	NextLockAt  *time.Time
	NextUnlockAt *time.Time
}

// parseHHMM parses an "HH:MM" string into hours and minutes.
func parseHHMM(s string) (int, int, error) {
	var h, m int
	_, err := fmt.Sscanf(s, "%d:%d", &h, &m)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid time %q: %w", s, err)
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, fmt.Errorf("invalid time %q: out of range", s)
	}
	return h, m, nil
}

// IsInWindow checks whether now (time-of-day) falls within the allow window [allowStart, allowEnd).
// Handles overnight windows (allowEnd < allowStart) correctly.
func IsInWindow(allowStart, allowEnd string, now time.Time) (bool, error) {
	sh, sm, err := parseHHMM(allowStart)
	if err != nil {
		return false, err
	}
	eh, em, err := parseHHMM(allowEnd)
	if err != nil {
		return false, err
	}

	nowM := now.Hour()*60 + now.Minute()
	startM := sh*60 + sm
	endM := eh*60 + em

	if startM < endM {
		// Normal window: e.g. 08:00–22:00
		return nowM >= startM && nowM < endM, nil
	}
	// Overnight window: e.g. 22:00–08:00
	return nowM >= startM || nowM < endM, nil
}

// IsInSchedule returns true if 'now' falls within any allow window of the schedule,
// considering only days-of-week and time-of-day.
func IsInSchedule(sched db.Schedule, now time.Time) (bool, error) {
	nowDOW := int(now.Weekday()) // 0=Sunday

	dayMatches := false
	for _, d := range sched.Days {
		if d == nowDOW {
			dayMatches = true
			break
		}
	}
	if !dayMatches {
		return false, nil
	}

	return IsInWindow(sched.AllowStart, sched.AllowEnd, now)
}

// IsRuleInAllowWindow returns true if now is in ANY allow window across all schedules.
// Empty schedule list = always blocked (no allow windows).
func IsRuleInAllowWindow(schedules []db.Schedule, now time.Time) (bool, error) {
	for _, s := range schedules {
		in, err := IsInSchedule(s, now)
		if err != nil {
			return false, err
		}
		if in {
			return true, nil
		}
	}
	return false, nil
}

// nextOccurrenceOf returns the next time (>= now) when the given day-of-week and HH:MM occur.
func nextOccurrenceOf(targetDOW int, hhMM string, now time.Time) (time.Time, error) {
	h, m, err := parseHHMM(hhMM)
	if err != nil {
		return time.Time{}, err
	}

	// Start from today
	candidate := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	nowDOW := int(now.Weekday())

	daysAhead := targetDOW - nowDOW
	if daysAhead < 0 {
		daysAhead += 7
	}

	candidate = candidate.AddDate(0, 0, daysAhead)

	// If candidate is in the past (same day but earlier time), move it a week forward
	if !candidate.After(now) {
		candidate = candidate.AddDate(0, 0, 7)
	}
	return candidate, nil
}

// NextUnlockAt returns the next time a locked rule will become unlocked.
// Returns nil if the rule has no schedules (always blocked).
func NextUnlockAt(schedules []db.Schedule, now time.Time) (*time.Time, error) {
	var earliest *time.Time

	for _, sched := range schedules {
		for _, day := range sched.Days {
			t, err := nextOccurrenceOf(day, sched.AllowStart, now)
			if err != nil {
				continue
			}
			if earliest == nil || t.Before(*earliest) {
				earliest = &t
			}
		}
	}
	return earliest, nil
}

// NextLockAt returns the next time an active (currently allowed) rule will become locked.
// It finds the nearest allow_end across currently-active schedules, looking within the next 7 days.
func NextLockAt(schedules []db.Schedule, now time.Time) (*time.Time, error) {
	var earliest *time.Time

	for _, sched := range schedules {
		inSched, err := IsInSchedule(sched, now)
		if err != nil || !inSched {
			continue
		}

		eh, em, err := parseHHMM(sched.AllowEnd)
		if err != nil {
			continue
		}

		// Candidate lock time = today at allow_end
		candidate := time.Date(now.Year(), now.Month(), now.Day(), eh, em, 0, 0, now.Location())

		// For overnight windows, if allow_end is earlier in day than allow_start, end is tomorrow
		sh, sm, err := parseHHMM(sched.AllowStart)
		if err != nil {
			continue
		}
		startM := sh*60 + sm
		endM := eh*60 + em
		if startM >= endM {
			// Overnight: if current time >= start, end is next day
			nowM := now.Hour()*60 + now.Minute()
			if nowM >= startM {
				candidate = candidate.AddDate(0, 0, 1)
			}
		}

		if candidate.After(now) {
			if earliest == nil || candidate.Before(*earliest) {
				earliest = &candidate
			}
		}
	}
	return earliest, nil
}

// ComputeRuleStatus computes the enforcement status for a rule at time 'now'.
// minutesUsedToday is the total minutes already used today for this rule.
func ComputeRuleStatus(rule db.Rule, minutesUsedToday int, now time.Time) (RuleStatus, error) {
	if !rule.Enabled {
		return RuleStatus{Status: "disabled"}, nil
	}

	inWindow, err := IsRuleInAllowWindow(rule.Schedules, now)
	if err != nil {
		return RuleStatus{}, err
	}

	limitOK := rule.DailyLimitMinutes == 0 || minutesUsedToday < rule.DailyLimitMinutes

	if inWindow && limitOK {
		// Currently active — compute next lock
		nextLock, err := NextLockAt(rule.Schedules, now)
		if err != nil {
			return RuleStatus{}, err
		}
		return RuleStatus{
			Status:     "active",
			NextLockAt: nextLock,
		}, nil
	}

	// Locked — compute reason
	reason := lockReason(!inWindow, !limitOK)

	// Compute next unlock
	var nextUnlock *time.Time
	if !inWindow {
		nextUnlock, err = NextUnlockAt(rule.Schedules, now)
		if err != nil {
			return RuleStatus{}, err
		}
	}
	// If limit is the only reason and schedules would allow it, next unlock is midnight (new day)
	if inWindow && !limitOK {
		midnight := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location())
		nextUnlock = &midnight
	}

	return RuleStatus{
		Status:       "locked",
		Reason:       &reason,
		NextUnlockAt: nextUnlock,
	}, nil
}

func lockReason(outsideSchedule, limitReached bool) string {
	if outsideSchedule && limitReached {
		return "both"
	}
	if outsideSchedule {
		return "outside_schedule"
	}
	return "daily_limit_reached"
}
