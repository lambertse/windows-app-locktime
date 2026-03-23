package engine

import (
	"testing"
	"time"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
)

func makeTime(hour, minute int) time.Time {
	// Use Sunday 2026-03-22 as a fixed reference (Sunday = DOW 0)
	return time.Date(2026, 3, 22, hour, minute, 0, 0, time.UTC)
}

// DOW 0 = Sunday
func makeSched(days []int, start, end string) db.Schedule {
	return db.Schedule{
		Days:       days,
		AllowStart: start,
		AllowEnd:   end,
	}
}

// ─────────────────────────────────────────
// IsInWindow tests
// ─────────────────────────────────────────

func TestIsInWindow_NormalWindow_Inside(t *testing.T) {
	now := makeTime(15, 30)
	ok, err := IsInWindow("08:00", "22:00", now)
	if err != nil || !ok {
		t.Fatalf("expected inside normal window 08:00–22:00 at 15:30, got ok=%v err=%v", ok, err)
	}
}

func TestIsInWindow_NormalWindow_Before(t *testing.T) {
	now := makeTime(7, 59)
	ok, err := IsInWindow("08:00", "22:00", now)
	if err != nil || ok {
		t.Fatalf("expected outside normal window 08:00–22:00 at 07:59, got ok=%v err=%v", ok, err)
	}
}

func TestIsInWindow_NormalWindow_After(t *testing.T) {
	now := makeTime(22, 0)
	ok, err := IsInWindow("08:00", "22:00", now)
	if err != nil || ok {
		t.Fatalf("expected outside normal window 08:00–22:00 at 22:00 (exclusive end), got ok=%v err=%v", ok, err)
	}
}

func TestIsInWindow_Overnight_AfterMidnight(t *testing.T) {
	// Window 22:00–08:00 (overnight). 01:00 is inside.
	now := makeTime(1, 0)
	ok, err := IsInWindow("22:00", "08:00", now)
	if err != nil || !ok {
		t.Fatalf("expected inside overnight window 22:00–08:00 at 01:00, got ok=%v err=%v", ok, err)
	}
}

func TestIsInWindow_Overnight_BeforeMidnight(t *testing.T) {
	// Window 22:00–08:00. 23:00 is inside.
	now := makeTime(23, 0)
	ok, err := IsInWindow("22:00", "08:00", now)
	if err != nil || !ok {
		t.Fatalf("expected inside overnight window 22:00–08:00 at 23:00, got ok=%v err=%v", ok, err)
	}
}

func TestIsInWindow_Overnight_Outside(t *testing.T) {
	// Window 22:00–08:00. 12:00 is outside.
	now := makeTime(12, 0)
	ok, err := IsInWindow("22:00", "08:00", now)
	if err != nil || ok {
		t.Fatalf("expected outside overnight window 22:00–08:00 at 12:00, got ok=%v err=%v", ok, err)
	}
}

func TestIsInWindow_Overnight_AtStart(t *testing.T) {
	// At exactly 22:00 (start of overnight window), should be inside.
	now := makeTime(22, 0)
	ok, err := IsInWindow("22:00", "08:00", now)
	if err != nil || !ok {
		t.Fatalf("expected inside overnight window at start 22:00, got ok=%v err=%v", ok, err)
	}
}

func TestIsInWindow_Overnight_AtEnd(t *testing.T) {
	// At exactly 08:00 (end of overnight window), should be outside (exclusive end).
	now := makeTime(8, 0)
	ok, err := IsInWindow("22:00", "08:00", now)
	if err != nil || ok {
		t.Fatalf("expected outside overnight window at end 08:00 (exclusive), got ok=%v err=%v", ok, err)
	}
}

// ─────────────────────────────────────────
// IsInSchedule tests (DOW aware)
// ─────────────────────────────────────────

func TestIsInSchedule_WrongDay(t *testing.T) {
	// makeTime uses Sunday (DOW 0). Schedule only has Monday (1).
	sched := makeSched([]int{1}, "08:00", "22:00")
	now := makeTime(15, 0)
	ok, err := IsInSchedule(sched, now)
	if err != nil || ok {
		t.Fatalf("expected not in schedule on wrong day, got ok=%v err=%v", ok, err)
	}
}

func TestIsInSchedule_RightDayRightTime(t *testing.T) {
	// Sunday = 0
	sched := makeSched([]int{0}, "08:00", "22:00")
	now := makeTime(15, 0)
	ok, err := IsInSchedule(sched, now)
	if err != nil || !ok {
		t.Fatalf("expected in schedule on correct day and time, got ok=%v err=%v", ok, err)
	}
}

func TestIsInSchedule_WeekdaySchedule_Weekend(t *testing.T) {
	// Schedule Mon–Fri (1–5). Sunday (0) should not match.
	sched := makeSched([]int{1, 2, 3, 4, 5}, "15:00", "20:00")
	now := makeTime(15, 30) // Sunday
	ok, err := IsInSchedule(sched, now)
	if err != nil || ok {
		t.Fatalf("expected not in schedule (weekend), got ok=%v err=%v", ok, err)
	}
}

// ─────────────────────────────────────────
// ComputeRuleStatus tests
// ─────────────────────────────────────────

func makeRule(enabled bool, dailyLimit int, schedules []db.Schedule) db.Rule {
	return db.Rule{
		ID:                "test-rule-id",
		Name:              "TestApp",
		Enabled:           enabled,
		DailyLimitMinutes: dailyLimit,
		Schedules:         schedules,
	}
}

func TestComputeRuleStatus_Disabled(t *testing.T) {
	rule := makeRule(false, 0, nil)
	status, err := ComputeRuleStatus(rule, 0, makeTime(15, 0))
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "disabled" {
		t.Fatalf("expected disabled, got %s", status.Status)
	}
}

func TestComputeRuleStatus_Active(t *testing.T) {
	// Sunday with schedule Sun 08:00–22:00, no limit
	rule := makeRule(true, 0, []db.Schedule{
		makeSched([]int{0}, "08:00", "22:00"),
	})
	status, err := ComputeRuleStatus(rule, 30, makeTime(15, 0))
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "active" {
		t.Fatalf("expected active, got %s", status.Status)
	}
}

func TestComputeRuleStatus_Locked_OutsideSchedule(t *testing.T) {
	// Sunday with schedule Mon–Fri only
	rule := makeRule(true, 0, []db.Schedule{
		makeSched([]int{1, 2, 3, 4, 5}, "08:00", "22:00"),
	})
	status, err := ComputeRuleStatus(rule, 0, makeTime(15, 0))
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "locked" {
		t.Fatalf("expected locked, got %s", status.Status)
	}
	if status.Reason == nil || *status.Reason != "outside_schedule" {
		t.Fatalf("expected reason outside_schedule, got %v", status.Reason)
	}
}

func TestComputeRuleStatus_Locked_DailyLimit(t *testing.T) {
	// Sunday with schedule all days 00:00–23:59, but limit reached
	rule := makeRule(true, 60, []db.Schedule{
		makeSched([]int{0}, "00:00", "23:59"),
	})
	status, err := ComputeRuleStatus(rule, 61, makeTime(15, 0))
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "locked" {
		t.Fatalf("expected locked, got %s", status.Status)
	}
	if status.Reason == nil || *status.Reason != "daily_limit_reached" {
		t.Fatalf("expected reason daily_limit_reached, got %v", status.Reason)
	}
}

func TestComputeRuleStatus_Locked_Both(t *testing.T) {
	// Outside schedule AND limit reached
	rule := makeRule(true, 60, []db.Schedule{
		makeSched([]int{1, 2, 3, 4, 5}, "08:00", "22:00"),
	})
	status, err := ComputeRuleStatus(rule, 61, makeTime(15, 0)) // Sunday, out of schedule
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "locked" {
		t.Fatalf("expected locked, got %s", status.Status)
	}
	if status.Reason == nil || *status.Reason != "both" {
		t.Fatalf("expected reason both, got %v", status.Reason)
	}
}

func TestComputeRuleStatus_NoSchedules_AlwaysBlocked(t *testing.T) {
	// No schedules = always locked
	rule := makeRule(true, 0, []db.Schedule{})
	status, err := ComputeRuleStatus(rule, 0, makeTime(15, 0))
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "locked" {
		t.Fatalf("expected locked with no schedules, got %s", status.Status)
	}
}

// ─────────────────────────────────────────
// NextLockAt tests
// ─────────────────────────────────────────

func TestNextLockAt_NormalWindow(t *testing.T) {
	// Active schedule Sun 08:00–22:00. At 15:00, next lock should be today at 22:00.
	sched := makeSched([]int{0}, "08:00", "22:00")
	now := makeTime(15, 0)
	nextLock, err := NextLockAt([]db.Schedule{sched}, now)
	if err != nil {
		t.Fatal(err)
	}
	if nextLock == nil {
		t.Fatal("expected non-nil next_lock_at")
	}
	expected := time.Date(2026, 3, 22, 22, 0, 0, 0, time.UTC)
	if !nextLock.Equal(expected) {
		t.Fatalf("expected %v, got %v", expected, *nextLock)
	}
}

func TestNextLockAt_OvernightWindow(t *testing.T) {
	// Overnight window Sun 22:00–08:00. At 23:00 (inside window), lock is next day 08:00.
	sched := makeSched([]int{0}, "22:00", "08:00")
	now := makeTime(23, 0)
	nextLock, err := NextLockAt([]db.Schedule{sched}, now)
	if err != nil {
		t.Fatal(err)
	}
	if nextLock == nil {
		t.Fatal("expected non-nil next_lock_at for overnight window")
	}
	expected := time.Date(2026, 3, 23, 8, 0, 0, 0, time.UTC)
	if !nextLock.Equal(expected) {
		t.Fatalf("expected %v, got %v", expected, *nextLock)
	}
}

// ─────────────────────────────────────────
// NextUnlockAt tests
// ─────────────────────────────────────────

func TestNextUnlockAt_NilForNoSchedules(t *testing.T) {
	nextUnlock, err := NextUnlockAt(nil, makeTime(15, 0))
	if err != nil {
		t.Fatal(err)
	}
	if nextUnlock != nil {
		t.Fatalf("expected nil next_unlock_at for no schedules, got %v", *nextUnlock)
	}
}

func TestNextUnlockAt_FutureDay(t *testing.T) {
	// Locked on Sunday. Schedule Mon 15:00–20:00. Next unlock = Mon 15:00.
	sched := makeSched([]int{1}, "15:00", "20:00")
	now := makeTime(15, 0) // Sunday
	nextUnlock, err := NextUnlockAt([]db.Schedule{sched}, now)
	if err != nil {
		t.Fatal(err)
	}
	if nextUnlock == nil {
		t.Fatal("expected non-nil next_unlock_at")
	}
	// Monday 2026-03-23 15:00
	expected := time.Date(2026, 3, 23, 15, 0, 0, 0, time.UTC)
	if !nextUnlock.Equal(expected) {
		t.Fatalf("expected %v, got %v", expected, *nextUnlock)
	}
}
