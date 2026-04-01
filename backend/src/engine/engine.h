#pragma once
#include <ctime>
#include <optional>
#include <string>
#include <vector>

namespace locktime {

struct Schedule {
  std::string id;
  std::string rule_id;
  std::vector<int> days;    // 0=Sunday .. 6=Saturday
  std::string allow_start;  // "HH:MM" 24h
  std::string allow_end;    // "HH:MM" 24h
  int warn_before_minutes = 0;
};

struct Rule {
  std::string id;
  std::string name;
  std::string exe_name;
  std::string exe_path;    // empty if not set
  std::string match_mode;  // "name" | "path"
  bool enabled = true;
  int daily_limit_minutes = 0;
  bool ifeo_active = false;
  std::vector<Schedule> schedules;
  std::string created_at;
  std::string updated_at;
};

struct RuleStatus {
  std::string status;  // "locked" | "active" | "disabled"
  std::string
      reason;  // "outside_schedule" | "daily_limit_reached" | "both" | ""
  std::optional<std::time_t> next_lock_at;
  std::optional<std::time_t> next_unlock_at;
};

// Core functions — all take std::time_t for testability, zero I/O.

/// Returns true if the time-of-day component of `now` (UTC) falls in
/// [allow_start, allow_end). Handles overnight windows (allow_end <
/// allow_start) correctly.
bool is_in_window(const std::string& allow_start, const std::string& allow_end,
                  std::time_t now);

/// Returns true if `now` falls within a schedule's DOW + time window.
/// Handles overnight windows crossing midnight.
bool is_in_schedule(const Schedule& sched, std::time_t now);

/// Returns true if `now` is within ANY schedule in the list.
/// Empty list = always blocked (returns false).
bool is_rule_in_allow_window(const std::vector<Schedule>& schedules,
                             std::time_t now);

/// Returns the next time (after `now`) the rule will transition from
/// locked→active. Returns nullopt if no schedules exist (permanently blocked).
std::optional<std::time_t> next_unlock_at(
    const std::vector<Schedule>& schedules, std::time_t now);

/// Returns the next time (after `now`) the rule will transition from
/// active→locked. Returns nullopt if currently not in any schedule.
std::optional<std::time_t> next_lock_at(const std::vector<Schedule>& schedules,
                                        std::time_t now);

/// Main enforcement function.
/// `minutes_used_today` — total minutes of usage already tracked today.
RuleStatus compute_rule_status(const Rule& rule, int minutes_used_today,
                               std::time_t now);

}  // namespace locktime
