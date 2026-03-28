package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
	"github.com/lambertse/windows-app-locktime/backend/internal/engine"
)

const serviceVersion = "1.0.0"

// Server holds shared state accessible by all handlers.
type Server struct {
	DB        *sql.DB
	StartedAt time.Time
}

// SetupRouter creates and configures the gin router.
func SetupRouter(s *Server) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// CORS middleware — allow requests from the frontend server (8090) and the
	// API server itself (8089). Empty origin covers same-origin and server-side
	// proxy requests (e.g. the Vite dev proxy).
	allowedOrigins := map[string]bool{
		"http://127.0.0.1:8089": true,
		"http://127.0.0.1:8090": true,
		"http://localhost:8090":  true,
	}
	r.Use(func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")
		if origin == "" || allowedOrigins[origin] {
			if origin != "" {
				c.Header("Access-Control-Allow-Origin", origin)
			}
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Content-Type")
		} else {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	v1 := r.Group("/api/v1")
	{
		// Status
		v1.GET("/status", s.handleGetStatus)

		// Rules CRUD
		v1.GET("/rules", s.handleListRules)
		v1.POST("/rules", s.handleCreateRule)
		v1.GET("/rules/:id", s.handleGetRule)
		v1.PUT("/rules/:id", s.handlePutRule)
		v1.PATCH("/rules/:id", s.handlePatchRule)
		v1.DELETE("/rules/:id", s.handleDeleteRule)

		// Overrides
		v1.POST("/rules/:id/override", s.handleCreateOverride)
		v1.DELETE("/rules/:id/override", s.handleDeleteOverride)

		// Usage — ORDER MATTERS: attempts must be before :rule_id
		v1.GET("/usage/attempts", s.handleGetAttempts)
		v1.GET("/usage", s.handleGetUsage)
		v1.GET("/usage/:rule_id", s.handleGetUsageByRule)

		// Check (for blocker.exe)
		v1.GET("/check", s.handleCheck)

		// Config
		v1.GET("/config", s.handleGetConfig)
		v1.PUT("/config", s.handlePutConfig)

		// System
		v1.GET("/system/processes", s.handleGetProcesses)
		v1.POST("/system/browse", s.handleBrowse)
	}

	return r
}

// ─────────────────────────────────────────
// GET /api/v1/status
// ─────────────────────────────────────────

func (s *Server) handleGetStatus(c *gin.Context) {
	now := time.Now().UTC()
	uptime := int64(now.Sub(s.StartedAt).Seconds())

	rules, err := db.GetRules(s.DB)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type ruleStatus struct {
		RuleID           string   `json:"rule_id"`
		RuleName         string   `json:"rule_name"`
		ExeName          string   `json:"exe_name"`
		Enabled          bool     `json:"enabled"`
		Status           string   `json:"status"`
		Reason           *string  `json:"reason"`
		BlockedSince     *string  `json:"blocked_since"`
		NextLockAt       *string  `json:"next_lock_at"`
		NextUnlockAt     *string  `json:"next_unlock_at"`
		CurrentlyRunning bool     `json:"currently_running"`
		PID              *int     `json:"pid"`
		SessionStarted   *string  `json:"session_started"`
		MinutesElapsed   *int     `json:"minutes_elapsed"`
	}

	// Fetch all open sessions once (avoids N+1 queries).
	openSessions, _ := db.GetOpenSessions(s.DB)
	openSessionByRuleID := make(map[string]db.UsageSession, len(openSessions))
	for _, sess := range openSessions {
		openSessionByRuleID[sess.RuleID] = sess
	}

	var statuses []ruleStatus
	for _, rule := range rules {
		todayMinutes, _ := db.GetDailyMinutes(s.DB, rule.ID, now.Format("2006-01-02"), now)
		rs, err := engine.ComputeRuleStatus(rule, todayMinutes, now)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		var nextLockStr, nextUnlockStr *string
		if rs.NextLockAt != nil {
			t := rs.NextLockAt.UTC().Format(time.RFC3339)
			nextLockStr = &t
		}
		if rs.NextUnlockAt != nil {
			t := rs.NextUnlockAt.UTC().Format(time.RFC3339)
			nextUnlockStr = &t
		}

		// Look up open session from pre-fetched map (O(1), no extra query).
		var pid *int
		var sessionStarted *string
		var minutesElapsed *int
		var blockedSince *string
		currentlyRunning := false

		if sess, ok := openSessionByRuleID[rule.ID]; ok {
			currentlyRunning = true
			if sess.PID != nil {
				pid = sess.PID
			}
			sessionStarted = &sess.StartedAt
			t, parseErr := time.Parse(time.RFC3339, sess.StartedAt)
			if parseErr == nil {
				elapsed := int(now.Sub(t).Minutes())
				minutesElapsed = &elapsed
			}
		}

		// Populate blocked_since from the session start time when the rule is locked.
		if rs.Status == "locked" && sessionStarted != nil {
			blockedSince = sessionStarted
		}

		statuses = append(statuses, ruleStatus{
			RuleID:           rule.ID,
			RuleName:         rule.Name,
			ExeName:          rule.ExeName,
			Enabled:          rule.Enabled,
			Status:           rs.Status,
			Reason:           rs.Reason,
			BlockedSince:     blockedSince,
			NextLockAt:       nextLockStr,
			NextUnlockAt:     nextUnlockStr,
			CurrentlyRunning: currentlyRunning,
			PID:              pid,
			SessionStarted:   sessionStarted,
			MinutesElapsed:   minutesElapsed,
		})
	}

	if statuses == nil {
		statuses = []ruleStatus{}
	}

	c.JSON(http.StatusOK, gin.H{
		"service": gin.H{
			"status":          "running",
			"version":         serviceVersion,
			"uptime_seconds":  uptime,
			"time_synced":     true,
			"ntp_offset_ms":   0,
		},
		"rules": statuses,
	})
}

// ─────────────────────────────────────────
// Rules
// ─────────────────────────────────────────

func (s *Server) handleListRules(c *gin.Context) {
	rules, err := db.GetRules(s.DB)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if rules == nil {
		rules = []db.Rule{}
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

func (s *Server) handleCreateRule(c *gin.Context) {
	var req struct {
		Name               string        `json:"name"`
		ExeName            string        `json:"exe_name"`
		ExePath            *string       `json:"exe_path"`
		MatchMode          string        `json:"match_mode"`
		Enabled            *bool         `json:"enabled"`
		DailyLimitMinutes  int           `json:"daily_limit_minutes"`
		Schedules          []scheduleReq `json:"schedules"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if req.ExeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "exe_name is required"})
		return
	}
	if req.MatchMode == "" {
		req.MatchMode = "name"
	}
	if req.MatchMode != "name" && req.MatchMode != "path" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "match_mode must be 'name' or 'path'"})
		return
	}
	if req.MatchMode == "path" && (req.ExePath == nil || *req.ExePath == "") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "exe_path is required when match_mode is 'path'"})
		return
	}

	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}

	rule := &db.Rule{
		ID:                uuid.NewString(),
		Name:              req.Name,
		ExeName:           req.ExeName,
		ExePath:           req.ExePath,
		MatchMode:         req.MatchMode,
		Enabled:           enabled,
		DailyLimitMinutes: req.DailyLimitMinutes,
		Schedules:         []db.Schedule{},
	}

	if err := db.CreateRule(s.DB, rule); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	for _, sr := range req.Schedules {
		sched := &db.Schedule{
			ID:                uuid.NewString(),
			RuleID:            rule.ID,
			Days:              sr.Days,
			AllowStart:        sr.AllowStart,
			AllowEnd:          sr.AllowEnd,
			WarnBeforeMinutes: sr.WarnBeforeMinutes,
		}
		if err := db.CreateSchedule(s.DB, sched); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		rule.Schedules = append(rule.Schedules, *sched)
	}

	fresh, _ := db.GetRuleByID(s.DB, rule.ID)
	if fresh != nil {
		rule = fresh
	}
	c.JSON(http.StatusCreated, gin.H{"rule": rule})
}

func (s *Server) handleGetRule(c *gin.Context) {
	rule, err := db.GetRuleByID(s.DB, c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if rule == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "rule not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"rule": rule})
}

func (s *Server) handlePutRule(c *gin.Context) {
	id := c.Param("id")
	existing, err := db.GetRuleByID(s.DB, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "rule not found"})
		return
	}

	var req struct {
		Name               string        `json:"name"`
		ExeName            string        `json:"exe_name"`
		ExePath            *string       `json:"exe_path"`
		MatchMode          string        `json:"match_mode"`
		Enabled            *bool         `json:"enabled"`
		DailyLimitMinutes  int           `json:"daily_limit_minutes"`
		Schedules          []scheduleReq `json:"schedules"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if req.ExeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "exe_name is required"})
		return
	}
	if req.MatchMode == "" {
		req.MatchMode = "name"
	}

	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}

	rule := &db.Rule{
		ID:                id,
		Name:              req.Name,
		ExeName:           req.ExeName,
		ExePath:           req.ExePath,
		MatchMode:         req.MatchMode,
		Enabled:           enabled,
		DailyLimitMinutes: req.DailyLimitMinutes,
	}
	if err := db.UpdateRule(s.DB, rule); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Replace schedules
	if err := db.DeleteSchedulesByRuleID(s.DB, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for _, sr := range req.Schedules {
		sched := &db.Schedule{
			ID:                uuid.NewString(),
			RuleID:            id,
			Days:              sr.Days,
			AllowStart:        sr.AllowStart,
			AllowEnd:          sr.AllowEnd,
			WarnBeforeMinutes: sr.WarnBeforeMinutes,
		}
		if err := db.CreateSchedule(s.DB, sched); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	fresh, _ := db.GetRuleByID(s.DB, id)
	c.JSON(http.StatusOK, gin.H{"rule": fresh})
}

func (s *Server) handlePatchRule(c *gin.Context) {
	id := c.Param("id")
	existing, err := db.GetRuleByID(s.DB, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "rule not found"})
		return
	}

	var raw map[string]interface{}
	if err := c.ShouldBindJSON(&raw); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Convert bool fields
	if v, ok := raw["enabled"]; ok {
		if b, ok := v.(bool); ok {
			raw["enabled"] = boolToInt(b)
		}
	}

	if err := db.PatchRule(s.DB, id, raw); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Immediately reconcile IFEO state so toggling enabled doesn't wait for restart.
	reconcileIFEOForRule(s, id)

	fresh, _ := db.GetRuleByID(s.DB, id)
	c.JSON(http.StatusOK, gin.H{"rule": fresh})
}

func (s *Server) handleDeleteRule(c *gin.Context) {
	id := c.Param("id")
	existing, err := db.GetRuleByID(s.DB, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "rule not found"})
		return
	}

	// Clear IFEO key before removing the rule from the DB so the exe is no longer intercepted.
	clearIFEOKey(existing.ExeName)

	if err := db.DeleteRule(s.DB, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// ─────────────────────────────────────────
// Overrides
// ─────────────────────────────────────────

func (s *Server) handleCreateOverride(c *gin.Context) {
	id := c.Param("id")
	existing, err := db.GetRuleByID(s.DB, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "rule not found"})
		return
	}

	var req struct {
		DurationMinutes int     `json:"duration_minutes"`
		Reason          *string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.DurationMinutes <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "duration_minutes must be > 0"})
		return
	}

	now := time.Now().UTC()
	expiresAt := now.Add(time.Duration(req.DurationMinutes) * time.Minute)
	override := &db.Override{
		RuleID:          id,
		GrantedAt:       now.Format(time.RFC3339),
		ExpiresAt:       expiresAt.Format(time.RFC3339),
		DurationMinutes: req.DurationMinutes,
		Reason:          req.Reason,
	}
	if err := db.CreateOverride(s.DB, override); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"override": gin.H{
			"rule_id":          id,
			"granted_at":       override.GrantedAt,
			"expires_at":       override.ExpiresAt,
			"duration_minutes": override.DurationMinutes,
			"reason":           override.Reason,
		},
	})
}

func (s *Server) handleDeleteOverride(c *gin.Context) {
	id := c.Param("id")
	now := time.Now().UTC()
	deleted, err := db.DeleteActiveOverride(s.DB, id, now)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !deleted {
		c.JSON(http.StatusNotFound, gin.H{"error": "no active override for this rule"})
		return
	}
	c.Status(http.StatusNoContent)
}

// ─────────────────────────────────────────
// Usage
// ─────────────────────────────────────────

func (s *Server) handleGetUsage(c *gin.Context) {
	now := time.Now().UTC()
	rangeParam := c.Query("range")
	fromParam := c.Query("from")
	toParam := c.Query("to")

	if rangeParam == "week" {
		s.handleWeeklyUsage(c, now)
		return
	}

	// Default: today
	date := now.Format("2006-01-02")
	if rangeParam == "today" || (fromParam == "" && toParam == "") {
		// use today
	} else if fromParam != "" {
		date = fromParam
	}

	rules, err := db.GetRules(s.DB)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type sessionSummary struct {
		StartedAt       string  `json:"started_at"`
		EndedAt         *string `json:"ended_at"`
		DurationMinutes int     `json:"duration_minutes"`
	}
	type usageSummary struct {
		RuleID            string           `json:"rule_id"`
		RuleName          string           `json:"rule_name"`
		ExeName           string           `json:"exe_name"`
		MinutesUsed       int              `json:"minutes_used"`
		DailyLimitMinutes int              `json:"daily_limit_minutes"`
		MinutesRemaining  int              `json:"minutes_remaining"`
		LimitReached      bool             `json:"limit_reached"`
		Sessions          []sessionSummary `json:"sessions"`
	}

	var usages []usageSummary
	for _, rule := range rules {
		sessions, err := db.GetUsageSessions(s.DB, rule.ID, date, date)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		totalMinutes := 0
		var summaries []sessionSummary
		for _, sess := range sessions {
			var dur int
			if sess.DurationMinutes != nil {
				dur = *sess.DurationMinutes
			} else {
				// Open session
				t, _ := time.Parse(time.RFC3339, sess.StartedAt)
				dur = int(now.Sub(t).Minutes())
				if dur < 0 {
					dur = 0
				}
			}
			totalMinutes += dur
			summaries = append(summaries, sessionSummary{
				StartedAt:       sess.StartedAt,
				EndedAt:         sess.EndedAt,
				DurationMinutes: dur,
			})
		}

		remaining := 0
		limitReached := false
		if rule.DailyLimitMinutes > 0 {
			remaining = rule.DailyLimitMinutes - totalMinutes
			if remaining < 0 {
				remaining = 0
				limitReached = true
			}
		}

		if summaries == nil {
			summaries = []sessionSummary{}
		}

		usages = append(usages, usageSummary{
			RuleID:            rule.ID,
			RuleName:          rule.Name,
			ExeName:           rule.ExeName,
			MinutesUsed:       totalMinutes,
			DailyLimitMinutes: rule.DailyLimitMinutes,
			MinutesRemaining:  remaining,
			LimitReached:      limitReached,
			Sessions:          summaries,
		})
	}

	if usages == nil {
		usages = []usageSummary{}
	}

	c.JSON(http.StatusOK, gin.H{
		"date":  date,
		"usage": usages,
	})
}

func (s *Server) handleWeeklyUsage(c *gin.Context, now time.Time) {
	// Week: Monday–Sunday (current ISO week)
	weekday := int(now.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	monday := now.AddDate(0, 0, -(weekday - 1))
	fromDate := monday.Format("2006-01-02")
	toDate := now.Format("2006-01-02")

	rules, err := db.GetRules(s.DB)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Build date range list
	var dates []string
	for d := monday; !d.After(now); d = d.AddDate(0, 0, 1) {
		dates = append(dates, d.Format("2006-01-02"))
	}

	type dailyBreakdown struct {
		Date        string `json:"date"`
		MinutesUsed int    `json:"minutes_used"`
	}
	type byRuleEntry struct {
		RuleID         string           `json:"rule_id"`
		RuleName       string           `json:"rule_name"`
		TotalMinutes   int              `json:"total_minutes"`
		DailyBreakdown []dailyBreakdown `json:"daily_breakdown"`
	}
	type ruleRef struct {
		RuleID      string `json:"rule_id"`
		RuleName    string `json:"rule_name"`
		MinutesUsed int    `json:"minutes_used"`
	}
	type byDayEntry struct {
		Date         string    `json:"date"`
		TotalMinutes int       `json:"total_minutes"`
		Rules        []ruleRef `json:"rules"`
	}

	// Accumulate minutes per rule+date
	minuteMap := make(map[string]map[string]int) // ruleID -> date -> minutes
	for _, rule := range rules {
		minuteMap[rule.ID] = make(map[string]int)
	}

	for _, date := range dates {
		sessions, err := db.GetUsageSessionsForDate(s.DB, date)
		if err != nil {
			continue
		}
		for _, sess := range sessions {
			var dur int
			if sess.DurationMinutes != nil {
				dur = *sess.DurationMinutes
			} else {
				t, _ := time.Parse(time.RFC3339, sess.StartedAt)
				dur = int(now.Sub(t).Minutes())
				if dur < 0 {
					dur = 0
				}
			}
			if _, ok := minuteMap[sess.RuleID]; ok {
				minuteMap[sess.RuleID][date] += dur
			}
		}
	}

	var byRule []byRuleEntry
	for _, rule := range rules {
		var breakdown []dailyBreakdown
		total := 0
		for _, date := range dates {
			m := minuteMap[rule.ID][date]
			total += m
			breakdown = append(breakdown, dailyBreakdown{Date: date, MinutesUsed: m})
		}
		byRule = append(byRule, byRuleEntry{
			RuleID:         rule.ID,
			RuleName:       rule.Name,
			TotalMinutes:   total,
			DailyBreakdown: breakdown,
		})
	}

	var byDay []byDayEntry
	for _, date := range dates {
		var ruleRefs []ruleRef
		dayTotal := 0
		for _, rule := range rules {
			m := minuteMap[rule.ID][date]
			if m > 0 {
				ruleRefs = append(ruleRefs, ruleRef{
					RuleID:      rule.ID,
					RuleName:    rule.Name,
					MinutesUsed: m,
				})
				dayTotal += m
			}
		}
		if ruleRefs == nil {
			ruleRefs = []ruleRef{}
		}
		byDay = append(byDay, byDayEntry{
			Date:         date,
			TotalMinutes: dayTotal,
			Rules:        ruleRefs,
		})
	}

	if byRule == nil {
		byRule = []byRuleEntry{}
	}
	if byDay == nil {
		byDay = []byDayEntry{}
	}

	c.JSON(http.StatusOK, gin.H{
		"range":   "week",
		"from":    fromDate,
		"to":      toDate,
		"by_rule": byRule,
		"by_day":  byDay,
	})
}

func (s *Server) handleGetUsageByRule(c *gin.Context) {
	ruleID := c.Param("rule_id")
	rule, err := db.GetRuleByID(s.DB, ruleID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if rule == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "rule not found"})
		return
	}

	now := time.Now().UTC()
	fromDate := now.Format("2006-01-02")
	toDate := fromDate

	if r := c.Query("range"); r == "today" {
		// use defaults
	} else {
		if f := c.Query("from"); f != "" {
			fromDate = f
		}
		if t := c.Query("to"); t != "" {
			toDate = t
		}
	}

	// Build date range
	from, err := time.Parse("2006-01-02", fromDate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid from date"})
		return
	}
	to, err := time.Parse("2006-01-02", toDate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid to date"})
		return
	}

	type dayEntry struct {
		Date        string `json:"date"`
		MinutesUsed int    `json:"minutes_used"`
	}

	var daily []dayEntry
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		date := d.Format("2006-01-02")
		sessions, _ := db.GetUsageSessions(s.DB, ruleID, date, date)
		total := 0
		for _, sess := range sessions {
			if sess.DurationMinutes != nil {
				total += *sess.DurationMinutes
			} else {
				t, _ := time.Parse(time.RFC3339, sess.StartedAt)
				total += int(now.Sub(t).Minutes())
			}
		}
		daily = append(daily, dayEntry{Date: date, MinutesUsed: total})
	}

	if daily == nil {
		daily = []dayEntry{}
	}

	c.JSON(http.StatusOK, gin.H{
		"rule_id":   ruleID,
		"rule_name": rule.Name,
		"range": gin.H{
			"from": fromDate,
			"to":   toDate,
		},
		"daily": daily,
	})
}

func (s *Server) handleGetAttempts(c *gin.Context) {
	now := time.Now().UTC()
	fromDate := now.Format("2006-01-02")
	toDate := fromDate

	if r := c.Query("range"); r == "today" {
		// use defaults
	} else {
		if f := c.Query("from"); f != "" {
			fromDate = f
		}
		if t := c.Query("to"); t != "" {
			toDate = t
		}
	}

	limitStr := c.DefaultQuery("limit", "100")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 {
		limit = 100
	}

	var ruleIDFilter *string
	if rid := c.Query("rule_id"); rid != "" {
		ruleIDFilter = &rid
	}

	entries, err := db.GetAuditAttempts(s.DB, fromDate, toDate, ruleIDFilter, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type attempt struct {
		ID       int64   `json:"id"`
		Ts       string  `json:"ts"`
		RuleID   *string `json:"rule_id"`
		RuleName *string `json:"rule_name"`
		ExePath  *string `json:"exe_path"`
		Reason   *string `json:"reason"`
	}

	attempts := make([]attempt, 0, len(entries))
	for _, e := range entries {
		a := attempt{
			ID:     e.ID,
			Ts:     e.Ts,
			RuleID: e.EntityID,
		}

		// Parse detail JSON for exe_path and reason
		if e.Detail != nil {
			var detail struct {
				ExePath string `json:"exe_path"`
				Reason  string `json:"reason"`
			}
			if err := json.Unmarshal([]byte(*e.Detail), &detail); err == nil {
				if detail.ExePath != "" {
					a.ExePath = &detail.ExePath
				}
				if detail.Reason != "" {
					a.Reason = &detail.Reason
				}
			}
		}

		// Look up rule name
		if e.EntityID != nil {
			if rule, err := db.GetRuleByID(s.DB, *e.EntityID); err == nil && rule != nil {
				a.RuleName = &rule.Name
			}
		}

		attempts = append(attempts, a)
	}

	c.JSON(http.StatusOK, gin.H{
		"from":     fromDate,
		"to":       toDate,
		"total":    len(attempts),
		"attempts": attempts,
	})
}

// ─────────────────────────────────────────
// Check (for blocker.exe)
// ─────────────────────────────────────────

func (s *Server) handleCheck(c *gin.Context) {
	exePath := c.Query("exe_path")
	if exePath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "exe_path is required"})
		return
	}

	now := time.Now().UTC()
	rules, err := db.GetRules(s.DB)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Find matching rule
	var matchedRule *db.Rule
	for i := range rules {
		rule := &rules[i]
		if !rule.Enabled {
			continue
		}
		switch rule.MatchMode {
		case "path":
			if rule.ExePath != nil && strings.EqualFold(*rule.ExePath, exePath) {
				matchedRule = rule
			}
		default:
			exeName := exePath
			if idx := strings.LastIndexAny(exePath, `/\`); idx >= 0 {
				exeName = exePath[idx+1:]
			}
			if strings.EqualFold(rule.ExeName, exeName) {
				matchedRule = rule
			}
		}
		if matchedRule != nil {
			break
		}
	}

	if matchedRule == nil {
		c.JSON(http.StatusOK, gin.H{
			"allowed":       true,
			"rule_id":       nil,
			"reason":        nil,
			"next_unlock_at": nil,
		})
		return
	}

	// Check override
	override, _ := db.GetActiveOverride(s.DB, matchedRule.ID, now)
	if override != nil {
		c.JSON(http.StatusOK, gin.H{
			"allowed":   true,
			"rule_id":   matchedRule.ID,
			"rule_name": matchedRule.Name,
			"reason":    nil,
			"next_unlock_at": nil,
		})
		return
	}

	todayMinutes, _ := db.GetDailyMinutes(s.DB, matchedRule.ID, now.Format("2006-01-02"), now)
	rs, err := engine.ComputeRuleStatus(*matchedRule, todayMinutes, now)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if rs.Status == "active" {
		c.JSON(http.StatusOK, gin.H{
			"allowed":        true,
			"rule_id":        matchedRule.ID,
			"rule_name":      matchedRule.Name,
			"reason":         nil,
			"next_unlock_at": nil,
		})
		return
	}

	// Blocked — log attempt
	detail := fmt.Sprintf(`{"exe_path":%q,"reason":%q}`, exePath, *rs.Reason)
	_ = db.InsertAuditLog(s.DB, "block_attempt", &matchedRule.ID, &detail)

	var nextUnlockStr *string
	if rs.NextUnlockAt != nil {
		t := rs.NextUnlockAt.UTC().Format(time.RFC3339)
		nextUnlockStr = &t
	}

	c.JSON(http.StatusOK, gin.H{
		"allowed":        false,
		"rule_id":        matchedRule.ID,
		"rule_name":      matchedRule.Name,
		"reason":         rs.Reason,
		"next_unlock_at": nextUnlockStr,
	})
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

func (s *Server) handleGetConfig(c *gin.Context) {
	cfg, err := db.GetConfig(s.DB)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"config": gin.H{
			"ntp_server":                  cfg["ntp_server"],
			"ntp_check_interval_seconds":  atoi(cfg["ntp_check_interval_seconds"]),
			"poll_interval_ms":            atoi(cfg["poll_interval_ms"]),
			"blocker_exe_path":            cfg["blocker_exe_path"],
			"log_retention_days":          atoi(cfg["log_retention_days"]),
		},
	})
}

func (s *Server) handlePutConfig(c *gin.Context) {
	var req map[string]interface{}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	allowed := map[string]bool{
		"ntp_server": true, "ntp_check_interval_seconds": true,
		"poll_interval_ms": true, "blocker_exe_path": true, "log_retention_days": true,
	}

	for k, v := range req {
		if !allowed[k] {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("unknown config key: %s", k)})
			return
		}
		if err := db.SetConfig(s.DB, k, fmt.Sprintf("%v", v)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	s.handleGetConfig(c)
}

// ─────────────────────────────────────────
// System Processes
// ─────────────────────────────────────────

func (s *Server) handleGetProcesses(c *gin.Context) {
	// On non-Windows this returns an empty list gracefully.
	// Real process list is returned by the Windows-only watcher.
	procs := getProcessList()
	if procs == nil {
		procs = []map[string]interface{}{}
	}
	c.JSON(http.StatusOK, gin.H{"processes": procs})
}

// ─────────────────────────────────────────
// System Browse (file dialog)
// ─────────────────────────────────────────

func (s *Server) handleBrowse(c *gin.Context) {
	var req struct {
		Filter string `json:"filter"`
	}
	_ = c.ShouldBindJSON(&req)
	if req.Filter == "" {
		req.Filter = `Executable Files (*.exe)|*.exe|All Files (*.*)|*.*`
	}

	path, cancelled, err := showFileBrowseDialog(req.Filter)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open file dialog"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"path":      path,
		"cancelled": cancelled,
	})
}

// ─────────────────────────────────────────
// Shared helper types
// ─────────────────────────────────────────

type scheduleReq struct {
	Days              []int  `json:"days"`
	AllowStart        string `json:"allow_start"`
	AllowEnd          string `json:"allow_end"`
	WarnBeforeMinutes int    `json:"warn_before_minutes"`
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func atoi(s string) int {
	v, _ := strconv.Atoi(s)
	return v
}
