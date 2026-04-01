#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <psapi.h>
#include <tlhelp32.h>
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <thread>

#include "common/constants.h"
#include "common/utils.h"
#include "engine/engine.h"
#include "watcher.h"

#pragma comment(lib, "psapi.lib")

namespace locktime {

// ── Constructor / Destructor
// ──────────────────────────────────────────────────

Watcher::Watcher(std::shared_ptr<Database> db) : db_(std::move(db)) {}

Watcher::~Watcher() { stop(); }

// ── start / stop
// ──────────────────────────────────────────────────────────────

void Watcher::start() {
  running_ = true;
  thread_ = std::thread([this] { poll_loop(); });
}

void Watcher::stop() {
  running_ = false;
  if (thread_.joinable()) thread_.join();
}

// ── close_all_sessions
// ────────────────────────────────────────────────────────

void Watcher::close_all_sessions(const std::string& reason) {
  auto now = std::time(nullptr);
  for (auto& [rule_id, pair] : active_sessions_) {
    db_->close_session(pair.first, now, reason);
  }
  active_sessions_.clear();
}

// ── enumerate_processes
// ───────────────────────────────────────────────────────

std::vector<ProcessEntry> Watcher::enumerate_processes() {
  std::vector<ProcessEntry> result;

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return result;

  PROCESSENTRY32W pe{};
  pe.dwSize = sizeof(pe);

  if (!Process32FirstW(snap, &pe)) {
    CloseHandle(snap);
    return result;
  }

  do {
    ProcessEntry entry;
    entry.pid = static_cast<int>(pe.th32ProcessID);

    // Convert wide exe name to narrow
    int len = WideCharToMultiByte(CP_UTF8, 0, pe.szExeFile, -1, nullptr, 0,
                                  nullptr, nullptr);
    if (len > 0) {
      std::string narrow(len, '\0');
      WideCharToMultiByte(CP_UTF8, 0, pe.szExeFile, -1, &narrow[0], len,
                          nullptr, nullptr);
      // Remove null terminator added by WideCharToMultiByte
      if (!narrow.empty() && narrow.back() == '\0') narrow.pop_back();
      entry.exe_name = narrow;
    }

    // Try to get full path
    HANDLE hProc =
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pe.th32ProcessID);
    if (hProc) {
      WCHAR path[MAX_PATH * 2]{};
      DWORD size = static_cast<DWORD>(std::size(path));
      if (QueryFullProcessImageNameW(hProc, 0, path, &size)) {
        int plen = WideCharToMultiByte(CP_UTF8, 0, path, -1, nullptr, 0,
                                       nullptr, nullptr);
        if (plen > 0) {
          std::string pnarrow(plen, '\0');
          WideCharToMultiByte(CP_UTF8, 0, path, -1, &pnarrow[0], plen, nullptr,
                              nullptr);
          if (!pnarrow.empty() && pnarrow.back() == '\0') pnarrow.pop_back();
          entry.full_path = pnarrow;
        }
      }
      CloseHandle(hProc);
    }

    result.push_back(std::move(entry));
  } while (Process32NextW(snap, &pe));

  CloseHandle(snap);
  return result;
}

// ── terminate_process
// ─────────────────────────────────────────────────────────

void Watcher::terminate_process(int pid) {
  HANDLE hProc = OpenProcess(PROCESS_TERMINATE, FALSE, static_cast<DWORD>(pid));
  if (hProc) {
    TerminateProcess(hProc, 1);
    CloseHandle(hProc);
  }
}

// ── poll_loop
// ─────────────────────────────────────────────────────────────────

void Watcher::poll_loop() {
  while (running_) {
    auto now = std::time(nullptr);
    auto procs = enumerate_processes();
    reconcile(procs, now);
    std::this_thread::sleep_for(std::chrono::milliseconds(kWatcherPollMs));
  }
}

// ── reconcile
// ─────────────────────────────────────────────────────────────────

void Watcher::reconcile(const std::vector<ProcessEntry>& procs,
                        std::time_t now) {
  auto rules = db_->get_rules();

  // Build a lower-case exe_name → pid map from the live process list.
  // Multiple processes with the same exe_name take the lowest PID (oldest).
  std::map<std::string, int> running_map;  // lower_exe_name → pid
  for (const auto& pe : procs) {
    std::string low = pe.exe_name;
    for (char& c : low)
      c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (running_map.find(low) == running_map.end()) {
      running_map[low] = pe.pid;
    }
  }

  for (const auto& rule : rules) {
    if (!rule.enabled) continue;

    std::string rule_low = rule.exe_name;
    for (char& c : rule_low)
      c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

    auto it = running_map.find(rule_low);
    bool is_running = (it != running_map.end());
    int pid = is_running ? it->second : 0;

    int minutes_used =
        db_->get_daily_minutes(rule.id, utils::today_date(), now);
    auto status = compute_rule_status(rule, minutes_used, now);

    if (status.status == "active") {
      // App is allowed — open a session if not already tracking.
      if (is_running &&
          active_sessions_.find(rule.id) == active_sessions_.end()) {
        int64_t sid = db_->open_session(rule.id, pid, now);
        active_sessions_[rule.id] = {sid, pid};
      }
      // If app stopped, close session.
      if (!is_running &&
          active_sessions_.find(rule.id) != active_sessions_.end()) {
        auto& [sid, _pid] = active_sessions_[rule.id];
        db_->close_session(sid, now, "stopped");
        active_sessions_.erase(rule.id);
      }
    } else if (status.status == "locked") {
      // App should be blocked — terminate if running.
      if (is_running) {
        terminate_process(pid);
        db_->insert_audit(
            "watcher_kill", rule.id,
            "pid=" + std::to_string(pid) + " reason=" + status.reason);
      }
      // Close any open session.
      if (active_sessions_.find(rule.id) != active_sessions_.end()) {
        auto& [sid, _pid] = active_sessions_[rule.id];
        db_->close_session(sid, now, "locked_" + status.reason);
        active_sessions_.erase(rule.id);
      }
    }
  }
}

}  // namespace locktime
#endif  // _WIN32
