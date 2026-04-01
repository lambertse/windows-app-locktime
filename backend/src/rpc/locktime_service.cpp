#include "locktime_service.h"

#include "common/constants.h"
#include "common/logger.h"
#include "common/utils.h"
#include "engine/engine.h"
#include "watcher/watcher.h"

// Generated protobuf header
#include <ibridger/common/error.h>

#include <algorithm>
#include <ctime>
#include <sstream>

#include "locktime.pb.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace locktime {

// ── Helpers
// ───────────────────────────────────────────────────────────────────

static std::error_code serial_err() {
  return ibridger::common::make_error_code(
      ibridger::common::Error::serialization_error);
}

static std::error_code not_found_err() {
  return ibridger::common::make_error_code(
      ibridger::common::Error::not_connected);
}

// Fill a proto Schedule from internal Schedule
static void fill_proto_schedule(const locktime::Schedule& s,
                                ::locktime::rpc::Schedule* p) {
  p->set_id(s.id);
  p->set_rule_id(s.rule_id);
  for (int d : s.days) p->add_days(d);
  p->set_allow_start(s.allow_start);
  p->set_allow_end(s.allow_end);
  p->set_warn_before_minutes(s.warn_before_minutes);
}

void LockTimeService::fill_proto_rule(const locktime::Rule& r,
                                      ::locktime::rpc::Rule* p) {
  p->set_id(r.id);
  p->set_name(r.name);
  p->set_exe_name(r.exe_name);
  p->set_exe_path(r.exe_path);
  p->set_match_mode(r.match_mode);
  p->set_enabled(r.enabled);
  p->set_daily_limit_minutes(r.daily_limit_minutes);
  p->set_created_at(r.created_at);
  p->set_updated_at(r.updated_at);
  for (const auto& s : r.schedules) {
    fill_proto_schedule(s, p->add_schedules());
  }
}

// Convert proto SchedulePayload into internal Schedule
static locktime::Schedule schedule_from_payload(
    const ::locktime::rpc::SchedulePayload& p, const std::string& rule_id) {
  locktime::Schedule s;
  s.id = utils::generate_uuid();
  s.rule_id = rule_id;
  s.allow_start = p.allow_start();
  s.allow_end = p.allow_end();
  s.warn_before_minutes = p.warn_before_minutes();
  for (int d : p.days()) s.days.push_back(d);
  return s;
}

// ── Constructor
// ───────────────────────────────────────────────────────────────

LockTimeService::LockTimeService(
    std::shared_ptr<Database> db,
    std::chrono::steady_clock::time_point started_at,
    std::shared_ptr<Watcher> watcher)
    : ServiceBase("locktime.rpc.LockTimeService"),
      db_(std::move(db)),
      started_at_(started_at),
      watcher_(watcher) {
  register_method("GetStatus",
                  [this](auto& p) { return handle_get_status(p); });
  register_method("ListRules",
                  [this](auto& p) { return handle_list_rules(p); });
  register_method("GetRule", [this](auto& p) { return handle_get_rule(p); });
  register_method("CreateRule",
                  [this](auto& p) { return handle_create_rule(p); });
  register_method("UpdateRule",
                  [this](auto& p) { return handle_update_rule(p); });
  register_method("PatchRule",
                  [this](auto& p) { return handle_patch_rule(p); });
  register_method("DeleteRule",
                  [this](auto& p) { return handle_delete_rule(p); });
  register_method("GrantOverride",
                  [this](auto& p) { return handle_grant_override(p); });
  register_method("RevokeOverride",
                  [this](auto& p) { return handle_revoke_override(p); });
  register_method("GetUsageToday",
                  [this](auto& p) { return handle_get_usage_today(p); });
  register_method("GetUsageWeek",
                  [this](auto& p) { return handle_get_usage_week(p); });
  register_method("GetBlockAttempts",
                  [this](auto& p) { return handle_get_block_attempts(p); });
  register_method("GetProcesses",
                  [this](auto& p) { return handle_get_processes(p); });
  register_method("GetConfig",
                  [this](auto& p) { return handle_get_config(p); });
  register_method("UpdateConfig",
                  [this](auto& p) { return handle_update_config(p); });
  register_method("CheckApp", [this](auto& p) { return handle_check_app(p); });
}

// ── GetStatus
// ─────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_get_status(
    const std::string& payload) {
  logger::log_info("handling GetStatus request");
  ::locktime::rpc::GetStatusRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now = std::time(nullptr);
  auto rules = db_->get_rules();

  ::locktime::rpc::GetStatusResponse resp;

  // Service info
  auto* svc = resp.mutable_service();
  svc->set_status("running");
  svc->set_version(kVersion);
  auto elapsed = std::chrono::steady_clock::now() - started_at_;
  svc->set_uptime_seconds(static_cast<int64_t>(
      std::chrono::duration_cast<std::chrono::seconds>(elapsed).count()));
  svc->set_time_synced(true);
  svc->set_ntp_offset_ms(0);

  // Rule statuses
  for (const auto& rule : rules) {
    int minutes_used =
        db_->get_daily_minutes(rule.id, utils::today_date(), now);
    auto status = compute_rule_status(rule, minutes_used, now);

    auto* entry = resp.add_rules();
    entry->set_rule_id(rule.id);
    entry->set_rule_name(rule.name);
    entry->set_exe_name(rule.exe_name);
    entry->set_enabled(rule.enabled);
    entry->set_status(status.status);
    entry->set_reason(status.reason);

    if (status.next_lock_at) {
      entry->set_next_lock_at(utils::format_iso8601(*status.next_lock_at));
    }
    if (status.next_unlock_at) {
      entry->set_next_unlock_at(utils::format_iso8601(*status.next_unlock_at));
    }
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── ListRules
// ─────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_list_rules(
    const std::string& payload) {
  ::locktime::rpc::ListRulesRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto rules = db_->get_rules();

  ::locktime::rpc::ListRulesResponse resp;
  for (const auto& r : rules) {
    fill_proto_rule(r, resp.add_rules());
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── GetRule
// ───────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_get_rule(
    const std::string& payload) {
  ::locktime::rpc::GetRuleRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto rule = db_->get_rule_by_id(req.id());
  if (!rule) return {{}, not_found_err()};

  ::locktime::rpc::GetRuleResponse resp;
  fill_proto_rule(*rule, resp.mutable_rule());

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── CreateRule
// ────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_create_rule(
    const std::string& payload) {
  ::locktime::rpc::CreateRuleRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now_str = utils::now_iso8601();
  locktime::Rule r;
  r.id = utils::generate_uuid();
  r.name = req.name();
  r.exe_name = req.exe_name();
  r.exe_path = req.exe_path();
  r.match_mode = req.match_mode().empty() ? "name" : req.match_mode();
  r.enabled = req.enabled();
  r.daily_limit_minutes = req.daily_limit_minutes();
  r.created_at = now_str;
  r.updated_at = now_str;

  for (const auto& sp : req.schedules()) {
    r.schedules.push_back(schedule_from_payload(sp, r.id));
  }

  db_->create_rule(r);
  db_->insert_audit("create_rule", r.id, r.name);
  logger::log_info("rule created: name='{}' exe='{}' enabled={}", r.name,
                   r.exe_name, r.enabled);

#ifdef _WIN32
  if (r.enabled) {
    set_ifeo(r.exe_name, kBlockerPath);
    db_->set_rule_ifeo_active(r.id, true);
    logger::log_info("IFEO set for '{}'", r.exe_name);
  }
#endif

  ::locktime::rpc::CreateRuleResponse resp;
  fill_proto_rule(r, resp.mutable_rule());

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── UpdateRule
// ────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_update_rule(
    const std::string& payload) {
  ::locktime::rpc::UpdateRuleRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto existing = db_->get_rule_by_id(req.id());
  if (!existing) return {{}, not_found_err()};

  locktime::Rule r = *existing;
  r.name = req.name();
  r.exe_name = req.exe_name();
  r.exe_path = req.exe_path();
  r.match_mode = req.match_mode().empty() ? "name" : req.match_mode();
  r.enabled = req.enabled();
  r.daily_limit_minutes = req.daily_limit_minutes();
  r.updated_at = utils::now_iso8601();
  r.schedules.clear();
  for (const auto& sp : req.schedules()) {
    r.schedules.push_back(schedule_from_payload(sp, r.id));
  }

  db_->update_rule(r);
  db_->insert_audit("update_rule", r.id, r.name);
  logger::log_info("rule updated: name='{}' exe='{}' enabled={}", r.name,
                   r.exe_name, r.enabled);

#ifdef _WIN32
  if (r.enabled) {
    set_ifeo(r.exe_name, kBlockerPath);
    db_->set_rule_ifeo_active(r.id, true);
    logger::log_info("IFEO set for '{}'", r.exe_name);
  } else {
    clear_ifeo(r.exe_name);
    db_->set_rule_ifeo_active(r.id, false);
    logger::log_info("IFEO cleared for '{}'", r.exe_name);
  }
#endif

  ::locktime::rpc::UpdateRuleResponse resp;
  fill_proto_rule(r, resp.mutable_rule());

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── PatchRule
// ─────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_patch_rule(
    const std::string& payload) {
  ::locktime::rpc::PatchRuleRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto existing = db_->get_rule_by_id(req.id());
  if (!existing) return {{}, not_found_err()};

  db_->patch_rule(req.id(), req.has_enabled(), req.enabled(), req.has_name(),
                  req.name());
  if (req.has_enabled()) {
    logger::log_info("rule patched: exe='{}' enabled={}", existing->exe_name,
                     req.enabled());
  }

#ifdef _WIN32
  if (req.has_enabled()) {
    if (req.enabled()) {
      set_ifeo(existing->exe_name, kBlockerPath);
      db_->set_rule_ifeo_active(req.id(), true);
      logger::log_info("IFEO set for '{}'", existing->exe_name);
    } else {
      clear_ifeo(existing->exe_name);
      db_->set_rule_ifeo_active(req.id(), false);
      logger::log_info("IFEO cleared for '{}'", existing->exe_name);
    }
  }
#endif

  auto updated = db_->get_rule_by_id(req.id());

  ::locktime::rpc::PatchRuleResponse resp;
  if (updated) fill_proto_rule(*updated, resp.mutable_rule());

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── DeleteRule
// ────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_delete_rule(
    const std::string& payload) {
  ::locktime::rpc::DeleteRuleRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto existing = db_->get_rule_by_id(req.id());
  if (!existing) return {{}, not_found_err()};

#ifdef _WIN32
  clear_ifeo(existing->exe_name);
  logger::log_info("IFEO cleared for '{}'", existing->exe_name);
#endif

  db_->delete_rule(req.id());
  db_->insert_audit("delete_rule", req.id(), existing->name);
  logger::log_info("rule deleted: name='{}' exe='{}'", existing->name,
                   existing->exe_name);

  ::locktime::rpc::DeleteRuleResponse resp;
  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── GrantOverride
// ─────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_grant_override(
    const std::string& payload) {
  ::locktime::rpc::GrantOverrideRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now = std::time(nullptr);
  Override o;
  o.rule_id = req.rule_id();
  o.granted_at = utils::format_iso8601(now);
  o.duration_minutes = req.duration_minutes();
  o.expires_at = utils::format_iso8601(now + req.duration_minutes() * 60);
  o.reason = req.reason();
  o.consumed = false;

  db_->create_override(o);
  db_->insert_audit("grant_override", o.rule_id,
                    std::to_string(o.duration_minutes) + "min: " + o.reason);
  logger::log_info("override granted: rule_id='{}' duration={}min reason='{}'",
                   o.rule_id, o.duration_minutes, o.reason);

  ::locktime::rpc::GrantOverrideResponse resp;
  auto* p = resp.mutable_override_info();
  p->set_rule_id(o.rule_id);
  p->set_granted_at(o.granted_at);
  p->set_expires_at(o.expires_at);
  p->set_duration_minutes(o.duration_minutes);
  p->set_reason(o.reason);

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── RevokeOverride
// ────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_revoke_override(
    const std::string& payload) {
  ::locktime::rpc::RevokeOverrideRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now = std::time(nullptr);
  bool revoked = db_->delete_active_override(req.rule_id(), now);

  if (revoked) {
    db_->insert_audit("revoke_override", req.rule_id(), "");
    logger::log_info("override revoked: rule_id='{}'", req.rule_id());
  }

  ::locktime::rpc::RevokeOverrideResponse resp;
  resp.set_revoked(revoked);

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── GetUsageToday
// ─────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_get_usage_today(
    const std::string& payload) {
  ::locktime::rpc::GetUsageTodayRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now = std::time(nullptr);
  auto today = utils::today_date();
  auto rules = db_->get_rules();

  ::locktime::rpc::GetUsageTodayResponse resp;
  resp.set_date(today);

  for (const auto& rule : rules) {
    int minutes_used = db_->get_daily_minutes(rule.id, today, now);
    auto sessions = db_->get_sessions_for_date(today);

    auto* entry = resp.add_usage();
    entry->set_rule_id(rule.id);
    entry->set_rule_name(rule.name);
    entry->set_exe_name(rule.exe_name);
    entry->set_minutes_used(minutes_used);
    entry->set_daily_limit_minutes(rule.daily_limit_minutes);

    int remaining = 0;
    if (rule.daily_limit_minutes > 0) {
      remaining = std::max(0, rule.daily_limit_minutes - minutes_used);
    }
    entry->set_minutes_remaining(remaining);
    entry->set_limit_reached(rule.daily_limit_minutes > 0 &&
                             minutes_used >= rule.daily_limit_minutes);

    for (const auto& s : sessions) {
      if (s.rule_id != rule.id) continue;
      auto* se = entry->add_sessions();
      se->set_started_at(s.started_at);
      se->set_ended_at(s.ended_at);
      se->set_duration_minutes(s.duration_minutes);
    }
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── GetUsageWeek
// ──────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_get_usage_week(
    const std::string& payload) {
  ::locktime::rpc::GetUsageWeekRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now = std::time(nullptr);
  auto rules = db_->get_rules();

  // Compute week range: last 7 days inclusive
  std::time_t week_start = now - 6 * 86400;
  auto from = utils::format_iso8601(week_start).substr(0, 10);
  auto to = utils::today_date();

  ::locktime::rpc::GetUsageWeekResponse resp;
  resp.set_range("week");
  resp.set_from(from);
  resp.set_to(to);

  for (const auto& rule : rules) {
    auto sessions = db_->get_sessions(rule.id, from, to);

    auto* by_rule = resp.add_by_rule();
    by_rule->set_rule_id(rule.id);
    by_rule->set_rule_name(rule.name);

    int total = 0;
    // Group by date
    std::map<std::string, int> daily;
    for (const auto& s : sessions) {
      daily[s.date] += s.duration_minutes;
      total += s.duration_minutes;
    }
    by_rule->set_total_minutes(total);
    for (const auto& [date, mins] : daily) {
      auto* db_entry = by_rule->add_daily_breakdown();
      db_entry->set_date(date);
      db_entry->set_minutes_used(mins);
    }
  }

  // by_day: for each day in range
  for (int i = 6; i >= 0; --i) {
    std::time_t day_t = now - i * 86400;
    auto date = utils::format_iso8601(day_t).substr(0, 10);

    auto* byday = resp.add_by_day();
    byday->set_date(date);

    int day_total = 0;
    for (const auto& rule : rules) {
      auto sessions = db_->get_sessions(rule.id, date, date);
      int mins = 0;
      for (const auto& s : sessions) mins += s.duration_minutes;
      if (mins > 0) {
        auto* re = byday->add_rules();
        re->set_rule_id(rule.id);
        re->set_rule_name(rule.name);
        re->set_minutes_used(mins);
        day_total += mins;
      }
    }
    byday->set_total_minutes(day_total);
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── GetBlockAttempts
// ──────────────────────────────────────────────────────────

std::pair<std::string, std::error_code>
LockTimeService::handle_get_block_attempts(const std::string& payload) {
  ::locktime::rpc::GetBlockAttemptsRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now = std::time(nullptr);
  std::string from, to;

  if (req.range() == "week") {
    from = utils::format_iso8601(now - 6 * 86400).substr(0, 10) + "T00:00:00Z";
    to = utils::format_iso8601(now).substr(0, 10) + "T23:59:59Z";
  } else {
    // Default: today
    from = utils::today_date() + "T00:00:00Z";
    to = utils::today_date() + "T23:59:59Z";
  }

  int limit = req.limit() > 0 ? req.limit() : 100;
  auto entries = db_->get_audit_attempts(from, to, req.rule_id(), limit);

  ::locktime::rpc::GetBlockAttemptsResponse resp;
  resp.set_from(from);
  resp.set_to(to);
  resp.set_total(static_cast<int>(entries.size()));

  for (const auto& ae : entries) {
    auto* a = resp.add_attempts();
    a->set_id(std::to_string(ae.id));
    a->set_rule_id(ae.entity_id);
    a->set_reason(ae.action);
    a->set_attempted_at(ae.ts);
    a->set_exe_path(ae.detail);
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── GetProcesses
// ──────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_get_processes(
    const std::string& payload) {
  ::locktime::rpc::GetProcessesRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  // Process list is populated by the watcher; here we return a stub.
  // In the full integration, this would call watcher->enumerate_processes().
  auto processes =
      watcher_ ? watcher_->enumerate_processes() : std::vector<ProcessEntry>{};
  ::locktime::rpc::GetProcessesResponse resp;

  for (const auto& p : processes) {
    auto* pe = resp.add_processes();
    pe->set_pid(p.pid);
    pe->set_name(p.exe_name);
    pe->set_full_path(p.full_path);
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── GetConfig
// ─────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_get_config(
    const std::string& payload) {
  ::locktime::rpc::GetConfigRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto cfg = db_->get_config();

  ::locktime::rpc::GetConfigResponse resp;
  auto* map = resp.mutable_config();
  for (const auto& [k, v] : cfg) {
    (*map)[k] = v;
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── UpdateConfig
// ──────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_update_config(
    const std::string& payload) {
  ::locktime::rpc::UpdateConfigRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  for (const auto& [k, v] : req.config()) {
    db_->set_config(k, v);
    logger::log_info("config updated: {}='{}'", k, v);
  }

  auto cfg = db_->get_config();

  ::locktime::rpc::UpdateConfigResponse resp;
  auto* map = resp.mutable_config();
  for (const auto& [k, v] : cfg) {
    (*map)[k] = v;
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── CheckApp
// ──────────────────────────────────────────────────────────────────

std::pair<std::string, std::error_code> LockTimeService::handle_check_app(
    const std::string& payload) {
  ::locktime::rpc::CheckAppRequest req;
  if (!req.ParseFromString(payload)) return {{}, serial_err()};

  auto now = std::time(nullptr);
  auto rules = db_->get_rules();

  // Extract exe name from path
  std::string exe_path = req.exe_path();
  std::string exe_name = exe_path;
  auto slash = exe_path.find_last_of("/\\");
  if (slash != std::string::npos) {
    exe_name = exe_path.substr(slash + 1);
  }
  // Lowercase for comparison
  std::string exe_lower = exe_name;
  for (char& c : exe_lower)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

  ::locktime::rpc::CheckAppResponse resp;
  resp.set_allowed(true);  // fail-open default

  for (const auto& rule : rules) {
    if (!rule.enabled) continue;

    // Match by exe name or path
    bool match = false;
    if (rule.match_mode == "path") {
      match = (exe_path == rule.exe_path);
    } else {
      std::string rule_lower = rule.exe_name;
      for (char& c : rule_lower)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      match = (exe_lower == rule_lower);
    }
    if (!match) continue;

    // Check active override
    auto ov = db_->get_active_override(rule.id, now);
    if (ov) {
      resp.set_allowed(true);
      resp.set_rule_id(rule.id);
      resp.set_rule_name(rule.name);
      resp.set_reason("override");
      break;
    }

    int minutes_used =
        db_->get_daily_minutes(rule.id, utils::today_date(), now);
    auto status = compute_rule_status(rule, minutes_used, now);

    if (status.status == "active") {
      resp.set_allowed(true);
    } else {
      resp.set_allowed(false);
      resp.set_rule_id(rule.id);
      resp.set_rule_name(rule.name);
      resp.set_reason(status.reason);
      if (status.next_unlock_at) {
        resp.set_next_unlock_at(utils::format_iso8601(*status.next_unlock_at));
      }
    }

    // Log block attempt
    if (!resp.allowed()) {
      db_->insert_audit("block_attempt", rule.id, exe_path);
      logger::log_warning("app blocked: exe='{}' rule='{}' reason='{}'",
                          exe_path, rule.name, resp.reason());
    }
    break;
  }

  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}

// ── IFEO helpers (Windows only)
// ───────────────────────────────────────────────

#ifdef _WIN32

void LockTimeService::set_ifeo(const std::string& exe_name,
                               const std::string& blocker_path) {
  std::wstring key_path =
      L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\"
      L"Image File Execution Options\\";
  // Convert exe_name to wstring
  std::wstring exe_w(exe_name.begin(), exe_name.end());
  key_path += exe_w;

  HKEY hKey = nullptr;
  DWORD disposition = 0;
  LONG rc = RegCreateKeyExW(HKEY_LOCAL_MACHINE, key_path.c_str(), 0, nullptr,
                            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr,
                            &hKey, &disposition);
  if (rc != ERROR_SUCCESS) return;

  std::wstring blocker_w(blocker_path.begin(), blocker_path.end());
  RegSetValueExW(hKey, L"Debugger", 0, REG_SZ,
                 reinterpret_cast<const BYTE*>(blocker_w.c_str()),
                 static_cast<DWORD>((blocker_w.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(hKey);
}

void LockTimeService::clear_ifeo(const std::string& exe_name) {
  std::wstring key_path =
      L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\"
      L"Image File Execution Options\\";
  std::wstring exe_w(exe_name.begin(), exe_name.end());
  key_path += exe_w;

  // Delete the Debugger value
  HKEY hKey = nullptr;
  LONG rc = RegOpenKeyExW(HKEY_LOCAL_MACHINE, key_path.c_str(), 0,
                          KEY_SET_VALUE, &hKey);
  if (rc == ERROR_SUCCESS) {
    RegDeleteValueW(hKey, L"Debugger");
    RegCloseKey(hKey);
  }
  // Optionally delete the empty key
  RegDeleteKeyW(HKEY_LOCAL_MACHINE, key_path.c_str());
}

#endif  // _WIN32

}  // namespace locktime
