#include "utils.h"

#include <cstdio>
#include <cstring>
#include <random>

namespace locktime {
namespace utils {

// ── UUID v4
// ───────────────────────────────────────────────────────────────────

std::string generate_uuid() {
  static thread_local std::mt19937 rng{std::random_device{}()};
  std::uniform_int_distribution<uint32_t> dist(0, 0xFFFFFFFF);

  uint32_t a = dist(rng);
  uint32_t b = dist(rng);
  uint32_t c = dist(rng);
  uint32_t d = dist(rng);

  // Set version 4 (bits 12-15 of time_hi_and_version)
  b = (b & 0xFFFF0FFF) | 0x00004000;
  // Set variant (bits 6-7 of clock_seq_hi)
  c = (c & 0x3FFFFFFF) | 0x80000000;

  char buf[37];
  std::snprintf(buf, sizeof(buf), "%08x-%04x-%04x-%04x-%04x%08x", a,
                (b >> 16) & 0xFFFF, b & 0xFFFF, (c >> 16) & 0xFFFF, c & 0xFFFF,
                d);
  return std::string(buf);
}

// ── Time formatting
// ───────────────────────────────────────────────────────────

std::string format_iso8601(std::time_t t) {
  struct tm utc_tm{};
#ifdef _WIN32
  gmtime_s(&utc_tm, &t);
#else
  gmtime_r(&t, &utc_tm);
#endif
  char buf[32];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &utc_tm);
  return std::string(buf);
}

std::string now_iso8601() { return format_iso8601(std::time(nullptr)); }

std::string today_date() {
  std::time_t now = std::time(nullptr);
  struct tm utc_tm{};
#ifdef _WIN32
  gmtime_s(&utc_tm, &now);
#else
  gmtime_r(&now, &utc_tm);
#endif
  char buf[16];
  std::strftime(buf, sizeof(buf), "%Y-%m-%d", &utc_tm);
  return std::string(buf);
}

std::time_t parse_iso8601(const std::string& s) {
  if (s.empty()) return 0;

  struct tm t{};
  int year = 0, mon = 0, mday = 0, hour = 0, min = 0, sec = 0;

  // Accept "YYYY-MM-DDTHH:MM:SSZ" or "YYYY-MM-DDTHH:MM:SS"
  int parsed = std::sscanf(s.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d", &year, &mon,
                           &mday, &hour, &min, &sec);
  if (parsed < 6) return 0;

  t.tm_year = year - 1900;
  t.tm_mon = mon - 1;
  t.tm_mday = mday;
  t.tm_hour = hour;
  t.tm_min = min;
  t.tm_sec = sec;
  t.tm_isdst = 0;

#ifdef _WIN32
  return _mkgmtime(&t);
#else
  return timegm(&t);
#endif
}

// ── HH:MM parsing
// ─────────────────────────────────────────────────────────────

bool parse_hhmm(const std::string& s, int& h, int& m) {
  if (s.size() < 4) return false;
  int parsed = std::sscanf(s.c_str(), "%d:%d", &h, &m);
  if (parsed != 2) return false;
  if (h < 0 || h > 23 || m < 0 || m > 59) return false;
  return true;
}

}  // namespace utils
}  // namespace locktime
