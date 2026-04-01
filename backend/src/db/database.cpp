#include "database.h"

#include <cstring>
#include <sstream>
#include <stdexcept>

#include "common/utils.h"

namespace locktime {

// ── Schema
// ────────────────────────────────────────────────────────────────────

static const char* kSchema = R"sql(
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  exe_name TEXT NOT NULL,
  exe_path TEXT,
  match_mode TEXT NOT NULL DEFAULT 'name',
  enabled INTEGER NOT NULL DEFAULT 1,
  daily_limit_minutes INTEGER NOT NULL DEFAULT 0,
  ifeo_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  days TEXT NOT NULL,
  allow_start TEXT NOT NULL,
  allow_end TEXT NOT NULL,
  warn_before_minutes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  pid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_minutes INTEGER,
  terminated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_sessions_rule_date
  ON usage_sessions(rule_id, date);

CREATE TABLE IF NOT EXISTS overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  reason TEXT,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  action TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT
);
)sql";

// ── JSON helpers for days field
// ───────────────────────────────────────────────

// Hand-rolled parser for "[0,1,2,3,4]" format
std::vector<int> Database::json_to_days(const std::string& json) {
  std::vector<int> result;
  if (json.empty()) return result;

  bool in_arr = false;
  std::string num;

  for (char c : json) {
    if (c == '[') {
      in_arr = true;
    } else if (c == ']') {
      if (!num.empty()) {
        result.push_back(std::stoi(num));
        num.clear();
      }
      break;
    } else if (in_arr) {
      if (std::isdigit(static_cast<unsigned char>(c))) {
        num += c;
      } else if (c == ',') {
        if (!num.empty()) {
          result.push_back(std::stoi(num));
          num.clear();
        }
      }
      // ignore spaces, etc.
    }
  }
  return result;
}

std::string Database::days_to_json(const std::vector<int>& days) {
  std::ostringstream ss;
  ss << "[";
  for (std::size_t i = 0; i < days.size(); ++i) {
    if (i > 0) ss << ",";
    ss << days[i];
  }
  ss << "]";
  return ss.str();
}

// ── Row readers
// ───────────────────────────────────────────────────────────────

Rule Database::read_rule_row(sqlite3_stmt* stmt) {
  Rule r;
  // Columns: id, name, exe_name, exe_path, match_mode, enabled,
  //          daily_limit_minutes, ifeo_active, created_at, updated_at
  auto text = [&](int col) -> std::string {
    const char* v =
        reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
    return v ? v : "";
  };
  r.id = text(0);
  r.name = text(1);
  r.exe_name = text(2);
  r.exe_path = text(3);
  r.match_mode = text(4);
  r.enabled = sqlite3_column_int(stmt, 5) != 0;
  r.daily_limit_minutes = sqlite3_column_int(stmt, 6);
  r.ifeo_active = sqlite3_column_int(stmt, 7) != 0;
  r.created_at = text(8);
  r.updated_at = text(9);
  return r;
}

Schedule Database::read_schedule_row(sqlite3_stmt* stmt) {
  Schedule s;
  // Columns: id, rule_id, days, allow_start, allow_end, warn_before_minutes
  auto text = [&](int col) -> std::string {
    const char* v =
        reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
    return v ? v : "";
  };
  s.id = text(0);
  s.rule_id = text(1);
  s.days = json_to_days(text(2));
  s.allow_start = text(3);
  s.allow_end = text(4);
  s.warn_before_minutes = sqlite3_column_int(stmt, 5);
  return s;
}

UsageSession Database::read_session_row(sqlite3_stmt* stmt) {
  UsageSession us;
  auto text = [&](int col) -> std::string {
    const char* v =
        reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
    return v ? v : "";
  };
  us.id = sqlite3_column_int64(stmt, 0);
  us.rule_id = text(1);
  us.date = text(2);
  us.pid = sqlite3_column_int(stmt, 3);
  us.started_at = text(4);
  us.ended_at = text(5);
  us.duration_minutes = sqlite3_column_int(stmt, 6);
  us.terminated_by = text(7);
  return us;
}

Override Database::read_override_row(sqlite3_stmt* stmt) {
  Override o;
  auto text = [&](int col) -> std::string {
    const char* v =
        reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
    return v ? v : "";
  };
  o.id = sqlite3_column_int64(stmt, 0);
  o.rule_id = text(1);
  o.granted_at = text(2);
  o.expires_at = text(3);
  o.duration_minutes = sqlite3_column_int(stmt, 4);
  o.reason = text(5);
  o.consumed = sqlite3_column_int(stmt, 6) != 0;
  return o;
}

AuditEntry Database::read_audit_row(sqlite3_stmt* stmt) {
  AuditEntry ae;
  auto text = [&](int col) -> std::string {
    const char* v =
        reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
    return v ? v : "";
  };
  ae.id = sqlite3_column_int64(stmt, 0);
  ae.ts = text(1);
  ae.action = text(2);
  ae.entity_id = text(3);
  ae.detail = text(4);
  return ae;
}

// ── Lifecycle
// ─────────────────────────────────────────────────────────────────

Database::Database(const std::string& path) {
  int rc = sqlite3_open(path.c_str(), &db_);
  if (rc != SQLITE_OK) {
    std::string msg = "sqlite3_open failed: ";
    msg += sqlite3_errmsg(db_);
    sqlite3_close(db_);
    db_ = nullptr;
    throw std::runtime_error(msg);
  }
  apply_schema();
  seed_config();
}

Database::~Database() {
  if (db_) {
    sqlite3_close(db_);
    db_ = nullptr;
  }
}

void Database::exec(const char* sql) {
  char* errmsg = nullptr;
  int rc = sqlite3_exec(db_, sql, nullptr, nullptr, &errmsg);
  if (rc != SQLITE_OK) {
    std::string msg = "sqlite3_exec failed: ";
    if (errmsg) {
      msg += errmsg;
      sqlite3_free(errmsg);
    }
    throw std::runtime_error(msg);
  }
}

void Database::apply_schema() { exec(kSchema); }

void Database::seed_config() {
  exec_stmt(
      "INSERT OR IGNORE INTO config(key, value) VALUES "
      "('ntp_enabled','true'),('ntp_offset_tolerance_ms','300000'),('timezone',"
      "'UTC');");
}

void Database::exec_stmt(const std::string& sql,
                         std::function<void(sqlite3_stmt*)> binder) {
  sqlite3_stmt* stmt = nullptr;
  int rc = sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr);
  if (rc != SQLITE_OK) {
    throw std::runtime_error(std::string("prepare failed: ") +
                             sqlite3_errmsg(db_));
  }
  if (binder) binder(stmt);
  rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
    throw std::runtime_error(std::string("step failed: ") +
                             sqlite3_errmsg(db_));
  }
}

// ── Private helper: load schedules while holding lock ────────────────────────

std::vector<Schedule> Database::load_schedules_for_rule_locked(
    const std::string& rule_id) {
  std::vector<Schedule> result;
  const char* sql =
      "SELECT id, rule_id, days, allow_start, allow_end, warn_before_minutes "
      "FROM schedules WHERE rule_id = ?;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return result;
  sqlite3_bind_text(stmt, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    result.push_back(read_schedule_row(stmt));
  }
  sqlite3_finalize(stmt);
  return result;
}

// ── Rules
// ─────────────────────────────────────────────────────────────────────

std::vector<Rule> Database::get_rules() {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<Rule> result;
  const char* sql =
      "SELECT id, name, exe_name, exe_path, match_mode, enabled, "
      "daily_limit_minutes, ifeo_active, created_at, updated_at FROM rules;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return result;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    Rule r = read_rule_row(stmt);
    r.schedules = load_schedules_for_rule_locked(r.id);
    result.push_back(std::move(r));
  }
  sqlite3_finalize(stmt);
  return result;
}

std::optional<Rule> Database::get_rule_by_id(const std::string& id) {
  std::lock_guard<std::mutex> lock(mu_);
  const char* sql =
      "SELECT id, name, exe_name, exe_path, match_mode, enabled, "
      "daily_limit_minutes, ifeo_active, created_at, updated_at FROM rules "
      "WHERE id = ?;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return std::nullopt;
  sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  std::optional<Rule> result;
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    Rule r = read_rule_row(stmt);
    sqlite3_finalize(stmt);
    r.schedules = load_schedules_for_rule_locked(r.id);
    result = std::move(r);
    return result;
  }
  sqlite3_finalize(stmt);
  return std::nullopt;
}

void Database::create_rule(const Rule& r) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt(
      "INSERT INTO rules(id, name, exe_name, exe_path, match_mode, enabled, "
      "daily_limit_minutes, ifeo_active, created_at, updated_at) "
      "VALUES(?,?,?,?,?,?,?,?,?,?);",
      [&](sqlite3_stmt* s) {
        sqlite3_bind_text(s, 1, r.id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 2, r.name.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 3, r.exe_name.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 4, r.exe_path.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 5, r.match_mode.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 6, r.enabled ? 1 : 0);
        sqlite3_bind_int(s, 7, r.daily_limit_minutes);
        sqlite3_bind_int(s, 8, r.ifeo_active ? 1 : 0);
        sqlite3_bind_text(s, 9, r.created_at.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 10, r.updated_at.c_str(), -1, SQLITE_TRANSIENT);
      });

  for (const auto& sched : r.schedules) {
    exec_stmt(
        "INSERT INTO schedules(id, rule_id, days, allow_start, allow_end, "
        "warn_before_minutes) "
        "VALUES(?,?,?,?,?,?);",
        [&](sqlite3_stmt* s) {
          sqlite3_bind_text(s, 1, sched.id.c_str(), -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 2, sched.rule_id.c_str(), -1, SQLITE_TRANSIENT);
          auto days_str = days_to_json(sched.days);
          sqlite3_bind_text(s, 3, days_str.c_str(), -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 4, sched.allow_start.c_str(), -1,
                            SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 5, sched.allow_end.c_str(), -1,
                            SQLITE_TRANSIENT);
          sqlite3_bind_int(s, 6, sched.warn_before_minutes);
        });
  }
}

void Database::update_rule(const Rule& r) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt(
      "UPDATE rules SET name=?, exe_name=?, exe_path=?, match_mode=?, "
      "enabled=?, "
      "daily_limit_minutes=?, updated_at=? WHERE id=?;",
      [&](sqlite3_stmt* s) {
        sqlite3_bind_text(s, 1, r.name.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 2, r.exe_name.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 3, r.exe_path.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 4, r.match_mode.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 5, r.enabled ? 1 : 0);
        sqlite3_bind_int(s, 6, r.daily_limit_minutes);
        auto now = utils::now_iso8601();
        sqlite3_bind_text(s, 7, now.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 8, r.id.c_str(), -1, SQLITE_TRANSIENT);
      });

  // Replace schedules
  exec_stmt("DELETE FROM schedules WHERE rule_id=?;", [&](sqlite3_stmt* s) {
    sqlite3_bind_text(s, 1, r.id.c_str(), -1, SQLITE_TRANSIENT);
  });
  for (const auto& sched : r.schedules) {
    exec_stmt(
        "INSERT INTO schedules(id, rule_id, days, allow_start, allow_end, "
        "warn_before_minutes) "
        "VALUES(?,?,?,?,?,?);",
        [&](sqlite3_stmt* s) {
          sqlite3_bind_text(s, 1, sched.id.c_str(), -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 2, r.id.c_str(), -1, SQLITE_TRANSIENT);
          auto days_str = days_to_json(sched.days);
          sqlite3_bind_text(s, 3, days_str.c_str(), -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 4, sched.allow_start.c_str(), -1,
                            SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 5, sched.allow_end.c_str(), -1,
                            SQLITE_TRANSIENT);
          sqlite3_bind_int(s, 6, sched.warn_before_minutes);
        });
  }
}

void Database::patch_rule(const std::string& id, bool has_enabled, bool enabled,
                          bool has_name, const std::string& name) {
  std::lock_guard<std::mutex> lock(mu_);
  if (has_enabled) {
    exec_stmt("UPDATE rules SET enabled=?, updated_at=? WHERE id=?;",
              [&](sqlite3_stmt* s) {
                sqlite3_bind_int(s, 1, enabled ? 1 : 0);
                auto now = utils::now_iso8601();
                sqlite3_bind_text(s, 2, now.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(s, 3, id.c_str(), -1, SQLITE_TRANSIENT);
              });
  }
  if (has_name) {
    exec_stmt("UPDATE rules SET name=?, updated_at=? WHERE id=?;",
              [&](sqlite3_stmt* s) {
                sqlite3_bind_text(s, 1, name.c_str(), -1, SQLITE_TRANSIENT);
                auto now = utils::now_iso8601();
                sqlite3_bind_text(s, 2, now.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(s, 3, id.c_str(), -1, SQLITE_TRANSIENT);
              });
  }
}

void Database::delete_rule(const std::string& id) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt("DELETE FROM rules WHERE id=?;", [&](sqlite3_stmt* s) {
    sqlite3_bind_text(s, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  });
}

void Database::set_rule_ifeo_active(const std::string& id, bool active) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt("UPDATE rules SET ifeo_active=? WHERE id=?;", [&](sqlite3_stmt* s) {
    sqlite3_bind_int(s, 1, active ? 1 : 0);
    sqlite3_bind_text(s, 2, id.c_str(), -1, SQLITE_TRANSIENT);
  });
}

// ── Schedules
// ─────────────────────────────────────────────────────────────────

std::vector<Schedule> Database::get_schedules_for_rule(
    const std::string& rule_id) {
  std::lock_guard<std::mutex> lock(mu_);
  return load_schedules_for_rule_locked(rule_id);
}

void Database::create_schedule(const Schedule& s) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt(
      "INSERT INTO schedules(id, rule_id, days, allow_start, allow_end, "
      "warn_before_minutes) "
      "VALUES(?,?,?,?,?,?);",
      [&](sqlite3_stmt* st) {
        sqlite3_bind_text(st, 1, s.id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, s.rule_id.c_str(), -1, SQLITE_TRANSIENT);
        auto days_str = days_to_json(s.days);
        sqlite3_bind_text(st, 3, days_str.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 4, s.allow_start.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 5, s.allow_end.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 6, s.warn_before_minutes);
      });
}

void Database::delete_schedules_for_rule(const std::string& rule_id) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt("DELETE FROM schedules WHERE rule_id=?;", [&](sqlite3_stmt* s) {
    sqlite3_bind_text(s, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
  });
}

// ── Usage Sessions
// ────────────────────────────────────────────────────────────

int64_t Database::open_session(const std::string& rule_id, int pid,
                               std::time_t started_at) {
  std::lock_guard<std::mutex> lock(mu_);
  auto ts = utils::format_iso8601(started_at);
  auto date = ts.substr(0, 10);  // "YYYY-MM-DD"

  exec_stmt(
      "INSERT INTO usage_sessions(rule_id, date, pid, started_at) "
      "VALUES(?,?,?,?);",
      [&](sqlite3_stmt* s) {
        sqlite3_bind_text(s, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 2, date.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 3, pid);
        sqlite3_bind_text(s, 4, ts.c_str(), -1, SQLITE_TRANSIENT);
      });
  return sqlite3_last_insert_rowid(db_);
}

void Database::close_session(int64_t session_id, std::time_t ended_at,
                             const std::string& terminated_by) {
  std::lock_guard<std::mutex> lock(mu_);
  auto end_ts = utils::format_iso8601(ended_at);

  // Get started_at to compute duration
  sqlite3_stmt* stmt = nullptr;
  std::string started_at_str;
  if (sqlite3_prepare_v2(db_,
                         "SELECT started_at FROM usage_sessions WHERE id=?;",
                         -1, &stmt, nullptr) == SQLITE_OK) {
    sqlite3_bind_int64(stmt, 1, session_id);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
      const char* v =
          reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
      if (v) started_at_str = v;
    }
    sqlite3_finalize(stmt);
  }

  int duration_minutes = 0;
  if (!started_at_str.empty()) {
    std::time_t start_t = utils::parse_iso8601(started_at_str);
    if (start_t > 0) {
      duration_minutes = static_cast<int>((ended_at - start_t) / 60);
      if (duration_minutes < 0) duration_minutes = 0;
    }
  }

  exec_stmt(
      "UPDATE usage_sessions SET ended_at=?, duration_minutes=?, "
      "terminated_by=? WHERE id=?;",
      [&](sqlite3_stmt* s) {
        sqlite3_bind_text(s, 1, end_ts.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 2, duration_minutes);
        sqlite3_bind_text(s, 3, terminated_by.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(s, 4, session_id);
      });
}

void Database::crash_recovery(std::time_t startup_time) {
  std::lock_guard<std::mutex> lock(mu_);
  // Close all open sessions (ended_at is NULL) using startup_time as end time.
  auto ts = utils::format_iso8601(startup_time);
  exec_stmt(
      "UPDATE usage_sessions SET ended_at=?, terminated_by='crash_recovery', "
      "duration_minutes = CAST((strftime('%s',?) - strftime('%s',started_at)) "
      "/ 60 AS INTEGER) "
      "WHERE ended_at IS NULL;",
      [&](sqlite3_stmt* s) {
        sqlite3_bind_text(s, 1, ts.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 2, ts.c_str(), -1, SQLITE_TRANSIENT);
      });
}

std::vector<UsageSession> Database::get_open_sessions() {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<UsageSession> result;
  const char* sql =
      "SELECT id, rule_id, date, pid, started_at, ended_at, "
      "COALESCE(duration_minutes,0), COALESCE(terminated_by,'') "
      "FROM usage_sessions WHERE ended_at IS NULL;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return result;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    result.push_back(read_session_row(stmt));
  }
  sqlite3_finalize(stmt);
  return result;
}

std::vector<UsageSession> Database::get_sessions_for_date(
    const std::string& date) {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<UsageSession> result;
  const char* sql =
      "SELECT id, rule_id, date, pid, started_at, COALESCE(ended_at,''), "
      "COALESCE(duration_minutes,0), COALESCE(terminated_by,'') "
      "FROM usage_sessions WHERE date=?;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return result;
  sqlite3_bind_text(stmt, 1, date.c_str(), -1, SQLITE_TRANSIENT);
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    result.push_back(read_session_row(stmt));
  }
  sqlite3_finalize(stmt);
  return result;
}

std::vector<UsageSession> Database::get_sessions(const std::string& rule_id,
                                                 const std::string& from,
                                                 const std::string& to) {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<UsageSession> result;
  const char* sql =
      "SELECT id, rule_id, date, pid, started_at, COALESCE(ended_at,''), "
      "COALESCE(duration_minutes,0), COALESCE(terminated_by,'') "
      "FROM usage_sessions WHERE rule_id=? AND date >= ? AND date <= ?;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return result;
  sqlite3_bind_text(stmt, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, from.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, to.c_str(), -1, SQLITE_TRANSIENT);
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    result.push_back(read_session_row(stmt));
  }
  sqlite3_finalize(stmt);
  return result;
}

int Database::get_daily_minutes(const std::string& rule_id,
                                const std::string& date, std::time_t now) {
  std::lock_guard<std::mutex> lock(mu_);

  // Sum closed sessions
  int total = 0;
  {
    const char* sql =
        "SELECT COALESCE(SUM(duration_minutes),0) FROM usage_sessions "
        "WHERE rule_id=? AND date=? AND ended_at IS NOT NULL;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
      sqlite3_bind_text(stmt, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(stmt, 2, date.c_str(), -1, SQLITE_TRANSIENT);
      if (sqlite3_step(stmt) == SQLITE_ROW) {
        total += sqlite3_column_int(stmt, 0);
      }
      sqlite3_finalize(stmt);
    }
  }

  // Add time from open sessions
  {
    const char* sql =
        "SELECT started_at FROM usage_sessions "
        "WHERE rule_id=? AND date=? AND ended_at IS NULL;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
      sqlite3_bind_text(stmt, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(stmt, 2, date.c_str(), -1, SQLITE_TRANSIENT);
      while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char* v =
            reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        if (v) {
          std::time_t start = utils::parse_iso8601(v);
          if (start > 0) {
            int mins = static_cast<int>((now - start) / 60);
            if (mins > 0) total += mins;
          }
        }
      }
      sqlite3_finalize(stmt);
    }
  }

  return total;
}

// ── Overrides
// ─────────────────────────────────────────────────────────────────

void Database::create_override(const Override& o) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt(
      "INSERT INTO overrides(rule_id, granted_at, expires_at, "
      "duration_minutes, reason, consumed) "
      "VALUES(?,?,?,?,?,?);",
      [&](sqlite3_stmt* s) {
        sqlite3_bind_text(s, 1, o.rule_id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 2, o.granted_at.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 3, o.expires_at.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 4, o.duration_minutes);
        sqlite3_bind_text(s, 5, o.reason.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 6, o.consumed ? 1 : 0);
      });
}

std::optional<Override> Database::get_active_override(
    const std::string& rule_id, std::time_t now) {
  std::lock_guard<std::mutex> lock(mu_);
  auto now_str = utils::format_iso8601(now);
  const char* sql =
      "SELECT id, rule_id, granted_at, expires_at, duration_minutes, "
      "COALESCE(reason,''), consumed "
      "FROM overrides WHERE rule_id=? AND expires_at > ? AND consumed=0 "
      "ORDER BY expires_at ASC LIMIT 1;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return std::nullopt;
  sqlite3_bind_text(stmt, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, now_str.c_str(), -1, SQLITE_TRANSIENT);
  std::optional<Override> result;
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    result = read_override_row(stmt);
  }
  sqlite3_finalize(stmt);
  return result;
}

bool Database::delete_active_override(const std::string& rule_id,
                                      std::time_t now) {
  std::lock_guard<std::mutex> lock(mu_);
  auto now_str = utils::format_iso8601(now);

  // Find the active override id
  int64_t oid = -1;
  {
    const char* sql =
        "SELECT id FROM overrides WHERE rule_id=? AND expires_at > ? AND "
        "consumed=0 LIMIT 1;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
      sqlite3_bind_text(stmt, 1, rule_id.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(stmt, 2, now_str.c_str(), -1, SQLITE_TRANSIENT);
      if (sqlite3_step(stmt) == SQLITE_ROW) {
        oid = sqlite3_column_int64(stmt, 0);
      }
      sqlite3_finalize(stmt);
    }
  }
  if (oid < 0) return false;

  exec_stmt("DELETE FROM overrides WHERE id=?;",
            [&](sqlite3_stmt* s) { sqlite3_bind_int64(s, 1, oid); });
  return true;
}

// ── Config
// ────────────────────────────────────────────────────────────────────

std::map<std::string, std::string> Database::get_config() {
  std::lock_guard<std::mutex> lock(mu_);
  std::map<std::string, std::string> result;
  const char* sql = "SELECT key, value FROM config;";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK)
    return result;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    const char* k = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    const char* v = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    if (k && v) result[k] = v;
  }
  sqlite3_finalize(stmt);
  return result;
}

void Database::set_config(const std::string& key, const std::string& value) {
  std::lock_guard<std::mutex> lock(mu_);
  exec_stmt("INSERT OR REPLACE INTO config(key, value) VALUES(?,?);",
            [&](sqlite3_stmt* s) {
              sqlite3_bind_text(s, 1, key.c_str(), -1, SQLITE_TRANSIENT);
              sqlite3_bind_text(s, 2, value.c_str(), -1, SQLITE_TRANSIENT);
            });
}

// ── Audit Log
// ─────────────────────────────────────────────────────────────────

void Database::insert_audit(const std::string& action,
                            const std::string& entity_id,
                            const std::string& detail) {
  std::lock_guard<std::mutex> lock(mu_);
  auto ts = utils::now_iso8601();
  exec_stmt(
      "INSERT INTO audit_log(ts, action, entity_id, detail) VALUES(?,?,?,?);",
      [&](sqlite3_stmt* s) {
        sqlite3_bind_text(s, 1, ts.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 2, action.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 3, entity_id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 4, detail.c_str(), -1, SQLITE_TRANSIENT);
      });
}

std::vector<AuditEntry> Database::get_audit_attempts(const std::string& from,
                                                     const std::string& to,
                                                     const std::string& rule_id,
                                                     int limit) {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<AuditEntry> result;

  std::string sql =
      "SELECT id, ts, action, COALESCE(entity_id,''), COALESCE(detail,'') "
      "FROM audit_log WHERE ts >= ? AND ts <= ?";
  if (!rule_id.empty()) {
    sql += " AND entity_id = ?";
  }
  sql += " ORDER BY ts DESC LIMIT ?;";

  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
    return result;

  sqlite3_bind_text(stmt, 1, from.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, to.c_str(), -1, SQLITE_TRANSIENT);
  int idx = 3;
  if (!rule_id.empty()) {
    sqlite3_bind_text(stmt, idx++, rule_id.c_str(), -1, SQLITE_TRANSIENT);
  }
  sqlite3_bind_int(stmt, idx, limit);

  while (sqlite3_step(stmt) == SQLITE_ROW) {
    result.push_back(read_audit_row(stmt));
  }
  sqlite3_finalize(stmt);
  return result;
}

}  // namespace locktime
