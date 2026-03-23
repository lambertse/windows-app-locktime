package db

import (
	"database/sql"
	"fmt"
	_ "modernc.org/sqlite"
)

const schemaSQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS rules (
	id                   TEXT PRIMARY KEY,
	name                 TEXT NOT NULL,
	exe_name             TEXT NOT NULL,
	exe_path             TEXT,
	match_mode           TEXT NOT NULL DEFAULT 'name',
	enabled              INTEGER NOT NULL DEFAULT 1,
	daily_limit_minutes  INTEGER NOT NULL DEFAULT 0,
	ifeo_active          INTEGER NOT NULL DEFAULT 0,
	created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
	updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS schedules (
	id                  TEXT PRIMARY KEY,
	rule_id             TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
	days                TEXT NOT NULL,
	allow_start         TEXT NOT NULL,
	allow_end           TEXT NOT NULL,
	warn_before_minutes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_sessions (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	rule_id          TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
	date             TEXT NOT NULL,
	pid              INTEGER,
	started_at       TEXT NOT NULL,
	ended_at         TEXT,
	duration_minutes INTEGER,
	terminated_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_sessions_rule_date ON usage_sessions(rule_id, date);

CREATE TABLE IF NOT EXISTS overrides (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	rule_id          TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
	granted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
	expires_at       TEXT NOT NULL,
	duration_minutes INTEGER NOT NULL,
	reason           TEXT,
	consumed         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config (
	key    TEXT PRIMARY KEY,
	value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
	action     TEXT NOT NULL,
	entity_id  TEXT,
	detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts     ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
`

const defaultConfig = `
INSERT OR IGNORE INTO config VALUES ('ntp_server', 'pool.ntp.org');
INSERT OR IGNORE INTO config VALUES ('ntp_check_interval_seconds', '300');
INSERT OR IGNORE INTO config VALUES ('poll_interval_ms', '1000');
INSERT OR IGNORE INTO config VALUES ('log_retention_days', '90');
INSERT OR IGNORE INTO config VALUES ('blocker_exe_path', 'C:\ProgramData\locktime\blocker.exe');
`

// Open opens (or creates) the SQLite DB at the given path and applies the schema.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	// Single writer to avoid SQLITE_BUSY in WAL mode
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(schemaSQL); err != nil {
		return nil, fmt.Errorf("apply schema: %w", err)
	}

	if _, err := db.Exec(defaultConfig); err != nil {
		return nil, fmt.Errorf("seed config: %w", err)
	}

	return db, nil
}
