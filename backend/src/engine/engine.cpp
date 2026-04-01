#include "engine.h"

#include <cstring>

#include "common/utils.h"

namespace locktime {

namespace {

// Returns the UTC struct tm for the given time_t.
struct tm utc_tm_of(std::time_t t) {
  struct tm result{};
#ifdef _WIN32
  gmtime_s(&result, &t);
#else
  gmtime_r(&t, &result);
#endif
  return result;
}

// Returns true if days vector contains the given day.
bool contains_day(const std::vector<int>& days, int day) {
  for (int d : days) {
    if (d == day) return true;
  }
  return false;
}

// Returns the next time_t (strictly after `now`) when the given DOW and HH:MM
// occur. Uses UTC throughout.
std::time_t next_occurrence_of(int target_dow, const std::string& hhmm,
                               std::time_t now) {
  int h = 0, m = 0;
  if (!utils::parse_hhmm(hhmm, h, m)) {
    return 0;
  }

  struct tm t = utc_tm_of(now);
  int now_dow = t.tm_wday;  // 0=Sunday

  // Build a candidate: today at hh:mm
  t.tm_hour = h;
  t.tm_min = m;
  t.tm_sec = 0;
  t.tm_isdst = 0;

  int days_ahead = target_dow - now_dow;
  if (days_ahead < 0) days_ahead += 7;

  // Advance by days_ahead days
  t.tm_mday += days_ahead;
#ifdef _WIN32
  std::time_t candidate = _mkgmtime(&t);
#else
  std::time_t candidate = timegm(&t);
#endif

  // If candidate is not in the future, push 7 days ahead
  if (candidate <= now) {
    t.tm_mday += 7;
#ifdef _WIN32
    candidate = _mkgmtime(&t);
#else
    candidate = timegm(&t);
#endif
  }

  return candidate;
}

}  // anonymous namespace

// ── is_in_window ─────────────────────────────────────────────────────────────

bool is_in_window(const std::string& allow_start, const std::string& allow_end,
                  std::time_t now) {
  int sh = 0, sm = 0, eh = 0, em = 0;
  if (!utils::parse_hhmm(allow_start, sh, sm)) return false;
  if (!utils::parse_hhmm(allow_end, eh, em)) return false;

  struct tm t = utc_tm_of(now);
  int now_m = t.tm_hour * 60 + t.tm_min;
  int start_m = sh * 60 + sm;
  int end_m = eh * 60 + em;

  if (start_m < end_m) {
    // Normal window e.g. 08:00–22:00
    return now_m >= start_m && now_m < end_m;
  }
  // Overnight window e.g. 22:00–08:00
  return now_m >= start_m || now_m < end_m;
}

// ── is_in_schedule
// ────────────────────────────────────────────────────────────

bool is_in_schedule(const Schedule& sched, std::time_t now) {
  int sh = 0, sm = 0, eh = 0, em = 0;
  if (!utils::parse_hhmm(sched.allow_start, sh, sm)) return false;
  if (!utils::parse_hhmm(sched.allow_end, eh, em)) return false;

  struct tm t = utc_tm_of(now);
  int now_m = t.tm_hour * 60 + t.tm_min;
  int start_m = sh * 60 + sm;
  int end_m = eh * 60 + em;
  bool overnight = end_m < start_m;  // e.g. 22:00–08:00

  if (overnight) {
    if (now_m < end_m) {
      // "After midnight" portion — the window started yesterday.
      int yesterday = (t.tm_wday + 6) % 7;
      return contains_day(sched.days, yesterday);
    }
    if (now_m >= start_m) {
      // "Before midnight" portion — check today.
      return contains_day(sched.days, t.tm_wday);
    }
    // Between end_m and start_m: outside window entirely.
    return false;
  }

  // Normal window: check today DOW and time range.
  return contains_day(sched.days, t.tm_wday) && now_m >= start_m &&
         now_m < end_m;
}

// ── is_rule_in_allow_window
// ───────────────────────────────────────────────────

bool is_rule_in_allow_window(const std::vector<Schedule>& schedules,
                             std::time_t now) {
  for (const auto& s : schedules) {
    if (is_in_schedule(s, now)) return true;
  }
  return false;
}

// ── next_unlock_at
// ────────────────────────────────────────────────────────────

std::optional<std::time_t> next_unlock_at(
    const std::vector<Schedule>& schedules, std::time_t now) {
  if (schedules.empty()) return std::nullopt;

  std::optional<std::time_t> earliest;

  for (const auto& sched : schedules) {
    for (int day : sched.days) {
      std::time_t t = next_occurrence_of(day, sched.allow_start, now);
      if (t == 0) continue;
      if (!earliest || t < *earliest) {
        earliest = t;
      }
    }
  }

  return earliest;
}

// ── next_lock_at
// ──────────────────────────────────────────────────────────────

std::optional<std::time_t> next_lock_at(const std::vector<Schedule>& schedules,
                                        std::time_t now) {
  std::optional<std::time_t> earliest;

  for (const auto& sched : schedules) {
    if (!is_in_schedule(sched, now)) continue;

    int eh = 0, em = 0;
    if (!utils::parse_hhmm(sched.allow_end, eh, em)) continue;

    int sh = 0, sm = 0;
    if (!utils::parse_hhmm(sched.allow_start, sh, sm)) continue;

    struct tm t = utc_tm_of(now);
    t.tm_hour = eh;
    t.tm_min = em;
    t.tm_sec = 0;
    t.tm_isdst = 0;

    int start_m = sh * 60 + sm;
    int end_m = eh * 60 + em;

    // For overnight windows, if current time >= start, end is next day
    if (start_m >= end_m) {
      int now_m = utc_tm_of(now).tm_hour * 60 + utc_tm_of(now).tm_min;
      if (now_m >= start_m) {
        t.tm_mday += 1;
      }
    }

#ifdef _WIN32
    std::time_t candidate = _mkgmtime(&t);
#else
    std::time_t candidate = timegm(&t);
#endif

    if (candidate > now) {
      if (!earliest || candidate < *earliest) {
        earliest = candidate;
      }
    }
  }

  return earliest;
}

// ── compute_rule_status
// ───────────────────────────────────────────────────────

RuleStatus compute_rule_status(const Rule& rule, int minutes_used_today,
                               std::time_t now) {
  if (!rule.enabled) {
    return RuleStatus{"disabled", "", std::nullopt, std::nullopt};
  }

  bool in_window = is_rule_in_allow_window(rule.schedules, now);
  bool limit_ok = (rule.daily_limit_minutes == 0) ||
                  (minutes_used_today < rule.daily_limit_minutes);

  if (in_window && limit_ok) {
    // Active — compute next lock time.
    auto nlock = next_lock_at(rule.schedules, now);
    return RuleStatus{"active", "", nlock, std::nullopt};
  }

  // Locked — determine reason.
  std::string reason;
  if (!in_window && !limit_ok) {
    reason = "both";
  } else if (!in_window) {
    reason = "outside_schedule";
  } else {
    reason = "daily_limit_reached";
  }

  // Compute next unlock time.
  std::optional<std::time_t> next_unlock;

  if (!in_window) {
    next_unlock = next_unlock_at(rule.schedules, now);
  } else if (!limit_ok) {
    // Limit is the only reason: next unlock is midnight (start of new day,
    // UTC).
    struct tm t = utc_tm_of(now);
    t.tm_hour = 0;
    t.tm_min = 0;
    t.tm_sec = 0;
    t.tm_mday += 1;  // next day
    t.tm_isdst = 0;
#ifdef _WIN32
    next_unlock = _mkgmtime(&t);
#else
    next_unlock = timegm(&t);
#endif
  }

  return RuleStatus{"locked", reason, std::nullopt, next_unlock};
}

}  // namespace locktime
