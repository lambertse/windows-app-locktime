#pragma once
#include <sqlite3.h>

#include <ctime>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "engine/engine.h"

namespace locktime {

struct UsageSession {
  int64_t id = 0;
  std::string rule_id;
  std::string date;
  int pid = 0;
  std::string started_at;
  std::string ended_at;  // empty if open
  int duration_minutes = 0;
  std::string terminated_by;
};

struct Override {
  int64_t id = 0;
  std::string rule_id;
  std::string granted_at;
  std::string expires_at;
  int duration_minutes = 0;
  std::string reason;
  bool consumed = false;
};

struct AuditEntry {
  int64_t id = 0;
  std::string ts;
  std::string action;
  std::string entity_id;
  std::string detail;
};

class Database {
 public:
  explicit Database(const std::string& path);
  ~Database();

  // Non-copyable
  Database(const Database&) = delete;
  Database& operator=(const Database&) = delete;

  // ── Rules ──────────────────────────────────────────────────────────────────
  std::vector<Rule> get_rules();
  std::optional<Rule> get_rule_by_id(const std::string& id);
  void create_rule(const Rule& r);
  void update_rule(const Rule& r);
  void patch_rule(const std::string& id, bool has_enabled, bool enabled,
                  bool has_name, const std::string& name);
  void delete_rule(const std::string& id);
  void set_rule_ifeo_active(const std::string& id, bool active);

  // ── Schedules ─────────────────────────────────────────────────────────────
  std::vector<Schedule> get_schedules_for_rule(const std::string& rule_id);
  void create_schedule(const Schedule& s);
  void delete_schedules_for_rule(const std::string& rule_id);

  // ── Usage Sessions ────────────────────────────────────────────────────────
  int64_t open_session(const std::string& rule_id, int pid,
                       std::time_t started_at);
  void close_session(int64_t session_id, std::time_t ended_at,
                     const std::string& terminated_by);
  void crash_recovery(std::time_t startup_time);
  std::vector<UsageSession> get_open_sessions();
  std::vector<UsageSession> get_sessions_for_date(const std::string& date);
  std::vector<UsageSession> get_sessions(const std::string& rule_id,
                                         const std::string& from,
                                         const std::string& to);
  int get_daily_minutes(const std::string& rule_id, const std::string& date,
                        std::time_t now);

  // ── Overrides ─────────────────────────────────────────────────────────────
  void create_override(const Override& o);
  std::optional<Override> get_active_override(const std::string& rule_id,
                                              std::time_t now);
  bool delete_active_override(const std::string& rule_id, std::time_t now);

  // ── Config ────────────────────────────────────────────────────────────────
  std::map<std::string, std::string> get_config();
  void set_config(const std::string& key, const std::string& value);

  // ── Audit Log ─────────────────────────────────────────────────────────────
  void insert_audit(const std::string& action,
                    const std::string& entity_id = "",
                    const std::string& detail = "");
  std::vector<AuditEntry> get_audit_attempts(const std::string& from,
                                             const std::string& to,
                                             const std::string& rule_id = "",
                                             int limit = 100);

 private:
  sqlite3* db_ = nullptr;
  std::mutex mu_;

  void exec(const char* sql);
  void apply_schema();
  void seed_config();

  // Execute a statement with optional binding callback.
  void exec_stmt(const std::string& sql,
                 std::function<void(sqlite3_stmt*)> binder = {});

  // Load schedules for a rule (called while holding mu_).
  std::vector<Schedule> load_schedules_for_rule_locked(
      const std::string& rule_id);

  // JSON helpers for days field stored as "[0,1,2]"
  static std::string days_to_json(const std::vector<int>& days);
  static std::vector<int> json_to_days(const std::string& json);

  // Row-reading helpers
  static Rule read_rule_row(sqlite3_stmt* stmt);
  static Schedule read_schedule_row(sqlite3_stmt* stmt);
  static UsageSession read_session_row(sqlite3_stmt* stmt);
  static Override read_override_row(sqlite3_stmt* stmt);
  static AuditEntry read_audit_row(sqlite3_stmt* stmt);
};

}  // namespace locktime
