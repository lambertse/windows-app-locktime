package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// ─────────────────────────────────────────
// Models
// ─────────────────────────────────────────

type Rule struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	ExeName            string     `json:"exe_name"`
	ExePath            *string    `json:"exe_path"`
	MatchMode          string     `json:"match_mode"`
	Enabled            bool       `json:"enabled"`
	DailyLimitMinutes  int        `json:"daily_limit_minutes"`
	IFEOActive         bool       `json:"-"`
	Schedules          []Schedule `json:"schedules"`
	CreatedAt          string     `json:"created_at"`
	UpdatedAt          string     `json:"updated_at"`
}

type Schedule struct {
	ID                string `json:"id"`
	RuleID            string `json:"rule_id"`
	Days              []int  `json:"days"`
	AllowStart        string `json:"allow_start"`
	AllowEnd          string `json:"allow_end"`
	WarnBeforeMinutes int    `json:"warn_before_minutes"`
}

type UsageSession struct {
	ID              int64    `json:"id"`
	RuleID          string   `json:"rule_id"`
	Date            string   `json:"date"`
	PID             *int     `json:"pid,omitempty"`
	StartedAt       string   `json:"started_at"`
	EndedAt         *string  `json:"ended_at"`
	DurationMinutes *int     `json:"duration_minutes"`
	TerminatedBy    *string  `json:"terminated_by,omitempty"`
}

type Override struct {
	ID              int64   `json:"id"`
	RuleID          string  `json:"rule_id"`
	GrantedAt       string  `json:"granted_at"`
	ExpiresAt       string  `json:"expires_at"`
	DurationMinutes int     `json:"duration_minutes"`
	Reason          *string `json:"reason"`
	Consumed        bool    `json:"consumed"`
}

type AuditEntry struct {
	ID       int64   `json:"id"`
	Ts       string  `json:"ts"`
	Action   string  `json:"action"`
	EntityID *string `json:"entity_id,omitempty"`
	Detail   *string `json:"detail,omitempty"`
}

// ─────────────────────────────────────────
// Rules
// ─────────────────────────────────────────

func GetRules(db *sql.DB) ([]Rule, error) {
	rows, err := db.Query(`
		SELECT id, name, exe_name, exe_path, match_mode, enabled,
		       daily_limit_minutes, ifeo_active, created_at, updated_at
		FROM rules ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rules []Rule
	for rows.Next() {
		var r Rule
		var enabledInt, ifeoInt int
		if err := rows.Scan(&r.ID, &r.Name, &r.ExeName, &r.ExePath, &r.MatchMode,
			&enabledInt, &r.DailyLimitMinutes, &ifeoInt, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		r.Enabled = enabledInt == 1
		r.IFEOActive = ifeoInt == 1
		rules = append(rules, r)
	}

	for i := range rules {
		schedules, err := GetSchedulesByRuleID(db, rules[i].ID)
		if err != nil {
			return nil, err
		}
		rules[i].Schedules = schedules
		if rules[i].Schedules == nil {
			rules[i].Schedules = []Schedule{}
		}
	}

	return rules, nil
}

func GetRuleByID(db *sql.DB, id string) (*Rule, error) {
	var r Rule
	var enabledInt, ifeoInt int
	err := db.QueryRow(`
		SELECT id, name, exe_name, exe_path, match_mode, enabled,
		       daily_limit_minutes, ifeo_active, created_at, updated_at
		FROM rules WHERE id = ?`, id).
		Scan(&r.ID, &r.Name, &r.ExeName, &r.ExePath, &r.MatchMode,
			&enabledInt, &r.DailyLimitMinutes, &ifeoInt, &r.CreatedAt, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Enabled = enabledInt == 1
	r.IFEOActive = ifeoInt == 1

	schedules, err := GetSchedulesByRuleID(db, r.ID)
	if err != nil {
		return nil, err
	}
	r.Schedules = schedules
	if r.Schedules == nil {
		r.Schedules = []Schedule{}
	}
	return &r, nil
}

func CreateRule(db *sql.DB, r *Rule) error {
	_, err := db.Exec(`
		INSERT INTO rules (id, name, exe_name, exe_path, match_mode, enabled, daily_limit_minutes)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.Name, r.ExeName, r.ExePath, r.MatchMode,
		boolToInt(r.Enabled), r.DailyLimitMinutes)
	return err
}

func UpdateRule(db *sql.DB, r *Rule) error {
	_, err := db.Exec(`
		UPDATE rules SET name=?, exe_name=?, exe_path=?, match_mode=?, enabled=?,
		       daily_limit_minutes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
		WHERE id=?`,
		r.Name, r.ExeName, r.ExePath, r.MatchMode,
		boolToInt(r.Enabled), r.DailyLimitMinutes, r.ID)
	return err
}

func PatchRule(db *sql.DB, id string, fields map[string]interface{}) error {
	if len(fields) == 0 {
		return nil
	}
	fields["updated_at"] = time.Now().UTC().Format(time.RFC3339)

	allowedCols := map[string]bool{
		"name": true, "exe_name": true, "exe_path": true, "match_mode": true,
		"enabled": true, "daily_limit_minutes": true, "updated_at": true,
	}

	query := "UPDATE rules SET "
	args := []interface{}{}
	first := true
	for col, val := range fields {
		if !allowedCols[col] {
			continue
		}
		if !first {
			query += ", "
		}
		query += col + "=?"
		args = append(args, val)
		first = false
	}
	query += " WHERE id=?"
	args = append(args, id)

	_, err := db.Exec(query, args...)
	return err
}

func DeleteRule(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM rules WHERE id=?`, id)
	return err
}

func SetRuleIFEOActive(db *sql.DB, id string, active bool) error {
	_, err := db.Exec(`UPDATE rules SET ifeo_active=? WHERE id=?`, boolToInt(active), id)
	return err
}

// ─────────────────────────────────────────
// Schedules
// ─────────────────────────────────────────

func GetSchedulesByRuleID(db *sql.DB, ruleID string) ([]Schedule, error) {
	rows, err := db.Query(`
		SELECT id, rule_id, days, allow_start, allow_end, warn_before_minutes
		FROM schedules WHERE rule_id=?`, ruleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var schedules []Schedule
	for rows.Next() {
		var s Schedule
		var daysJSON string
		if err := rows.Scan(&s.ID, &s.RuleID, &daysJSON, &s.AllowStart, &s.AllowEnd, &s.WarnBeforeMinutes); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(daysJSON), &s.Days); err != nil {
			return nil, fmt.Errorf("unmarshal days: %w", err)
		}
		schedules = append(schedules, s)
	}
	return schedules, nil
}

func CreateSchedule(db *sql.DB, s *Schedule) error {
	daysJSON, err := json.Marshal(s.Days)
	if err != nil {
		return err
	}
	_, err = db.Exec(`
		INSERT INTO schedules (id, rule_id, days, allow_start, allow_end, warn_before_minutes)
		VALUES (?, ?, ?, ?, ?, ?)`,
		s.ID, s.RuleID, string(daysJSON), s.AllowStart, s.AllowEnd, s.WarnBeforeMinutes)
	return err
}

func DeleteSchedulesByRuleID(db *sql.DB, ruleID string) error {
	_, err := db.Exec(`DELETE FROM schedules WHERE rule_id=?`, ruleID)
	return err
}

// ─────────────────────────────────────────
// Usage Sessions
// ─────────────────────────────────────────

func OpenUsageSession(db *sql.DB, ruleID string, pid int, startedAt time.Time) (int64, error) {
	date := startedAt.UTC().Format("2006-01-02")
	res, err := db.Exec(`
		INSERT INTO usage_sessions (rule_id, date, pid, started_at)
		VALUES (?, ?, ?, ?)`,
		ruleID, date, pid, startedAt.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func CloseUsageSession(db *sql.DB, sessionID int64, endedAt time.Time, terminatedBy string) error {
	_, err := db.Exec(`
		UPDATE usage_sessions
		SET ended_at         = ?,
		    duration_minutes = CAST((julianday(?) - julianday(started_at)) * 1440 AS INTEGER),
		    terminated_by    = ?
		WHERE id = ? AND ended_at IS NULL`,
		endedAt.UTC().Format(time.RFC3339),
		endedAt.UTC().Format(time.RFC3339),
		terminatedBy,
		sessionID)
	return err
}

func CrashRecovery(db *sql.DB, startupTime time.Time) error {
	ts := startupTime.UTC().Format(time.RFC3339)
	_, err := db.Exec(`
		UPDATE usage_sessions
		SET ended_at         = ?,
		    duration_minutes = CAST((julianday(?) - julianday(started_at)) * 1440 AS INTEGER),
		    terminated_by    = 'crash_recovery'
		WHERE ended_at IS NULL`, ts, ts)
	if err != nil {
		return err
	}
	detail := fmt.Sprintf(`{"startup_time":"%s"}`, ts)
	_, err = db.Exec(`INSERT INTO audit_log (action, detail) VALUES ('crash_recovery', ?)`, detail)
	return err
}

func GetUsageSessions(db *sql.DB, ruleID string, fromDate, toDate string) ([]UsageSession, error) {
	rows, err := db.Query(`
		SELECT id, rule_id, date, pid, started_at, ended_at, duration_minutes, terminated_by
		FROM usage_sessions
		WHERE rule_id=? AND date >= ? AND date <= ?
		ORDER BY started_at ASC`,
		ruleID, fromDate, toDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

func GetUsageSessionsForDate(db *sql.DB, date string) ([]UsageSession, error) {
	rows, err := db.Query(`
		SELECT id, rule_id, date, pid, started_at, ended_at, duration_minutes, terminated_by
		FROM usage_sessions WHERE date=? ORDER BY started_at ASC`, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

func GetOpenSessions(db *sql.DB) ([]UsageSession, error) {
	rows, err := db.Query(`
		SELECT id, rule_id, date, pid, started_at, ended_at, duration_minutes, terminated_by
		FROM usage_sessions WHERE ended_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

func scanSessions(rows *sql.Rows) ([]UsageSession, error) {
	var sessions []UsageSession
	for rows.Next() {
		var s UsageSession
		if err := rows.Scan(&s.ID, &s.RuleID, &s.Date, &s.PID,
			&s.StartedAt, &s.EndedAt, &s.DurationMinutes, &s.TerminatedBy); err != nil {
			return nil, err
		}
		sessions = append(sessions, s)
	}
	return sessions, nil
}

// GetDailyMinutes returns total minutes used for a rule on a given date (including open sessions).
func GetDailyMinutes(db *sql.DB, ruleID string, date string, now time.Time) (int, error) {
	rows, err := db.Query(`
		SELECT started_at, ended_at, duration_minutes
		FROM usage_sessions WHERE rule_id=? AND date=?`, ruleID, date)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	total := 0
	for rows.Next() {
		var startedAt string
		var endedAt *string
		var durMin *int
		if err := rows.Scan(&startedAt, &endedAt, &durMin); err != nil {
			return 0, err
		}
		if endedAt != nil && durMin != nil {
			total += *durMin
		} else {
			// Open session — compute elapsed
			t, err := time.Parse(time.RFC3339, startedAt)
			if err == nil {
				elapsed := int(now.Sub(t).Minutes())
				if elapsed > 0 {
					total += elapsed
				}
			}
		}
	}
	return total, nil
}

// ─────────────────────────────────────────
// Overrides
// ─────────────────────────────────────────

func CreateOverride(db *sql.DB, o *Override) error {
	_, err := db.Exec(`
		INSERT INTO overrides (rule_id, granted_at, expires_at, duration_minutes, reason)
		VALUES (?, ?, ?, ?, ?)`,
		o.RuleID, o.GrantedAt, o.ExpiresAt, o.DurationMinutes, o.Reason)
	return err
}

func GetActiveOverride(db *sql.DB, ruleID string, now time.Time) (*Override, error) {
	ts := now.UTC().Format(time.RFC3339)
	var o Override
	err := db.QueryRow(`
		SELECT id, rule_id, granted_at, expires_at, duration_minutes, reason, consumed
		FROM overrides
		WHERE rule_id=? AND expires_at > ? AND consumed=0
		ORDER BY granted_at DESC LIMIT 1`, ruleID, ts).
		Scan(&o.ID, &o.RuleID, &o.GrantedAt, &o.ExpiresAt, &o.DurationMinutes, &o.Reason, &o.Consumed)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

func DeleteActiveOverride(db *sql.DB, ruleID string, now time.Time) (bool, error) {
	ts := now.UTC().Format(time.RFC3339)
	res, err := db.Exec(`
		DELETE FROM overrides WHERE rule_id=? AND expires_at > ? AND consumed=0`, ruleID, ts)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

func GetConfig(db *sql.DB) (map[string]string, error) {
	rows, err := db.Query(`SELECT key, value FROM config`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cfg := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		cfg[k] = v
	}
	return cfg, nil
}

func SetConfig(db *sql.DB, key, value string) error {
	_, err := db.Exec(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`, key, value)
	return err
}

// ─────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────

func InsertAuditLog(db *sql.DB, action string, entityID *string, detail *string) error {
	_, err := db.Exec(`INSERT INTO audit_log (action, entity_id, detail) VALUES (?, ?, ?)`,
		action, entityID, detail)
	return err
}

func GetAuditAttempts(db *sql.DB, fromDate, toDate string, ruleID *string, limit int) ([]AuditEntry, error) {
	q := `SELECT al.id, al.ts, al.action, al.entity_id, al.detail
		  FROM audit_log al
		  WHERE al.action='block_attempt'
		    AND substr(al.ts, 1, 10) >= ? AND substr(al.ts, 1, 10) <= ?`
	args := []interface{}{fromDate, toDate}
	if ruleID != nil {
		q += ` AND al.entity_id=?`
		args = append(args, *ruleID)
	}
	q += ` ORDER BY al.ts DESC LIMIT ?`
	args = append(args, limit)

	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.Ts, &e.Action, &e.EntityID, &e.Detail); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
