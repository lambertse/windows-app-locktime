#pragma once
#include <ctime>
#include <string>

namespace locktime {
namespace utils {

/// Generate a random UUID v4 (e.g. "550e8400-e29b-41d4-a716-446655440000")
std::string generate_uuid();

/// Current UTC time formatted as "YYYY-MM-DDTHH:MM:SSZ"
std::string now_iso8601();

/// Current UTC date as "YYYY-MM-DD"
std::string today_date();

/// Format any time_t as "YYYY-MM-DDTHH:MM:SSZ" (UTC)
std::string format_iso8601(std::time_t t);

/// Parse "YYYY-MM-DDTHH:MM:SSZ" or "YYYY-MM-DDTHH:MM:SS" → time_t, returns 0 on
/// failure
std::time_t parse_iso8601(const std::string& s);

/// Parse "HH:MM" → h and m integers. Returns false on failure.
bool parse_hhmm(const std::string& s, int& h, int& m);

}  // namespace utils
}  // namespace locktime
