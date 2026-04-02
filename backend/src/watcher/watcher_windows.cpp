#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <psapi.h>
#include <tlhelp32.h>
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <thread>

#include "common/constants.h"
#include "common/logger.h"
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
  logger::log_info("watcher started (poll interval: {}ms)", kWatcherPollMs);
}

void Watcher::stop() {
  running_ = false;
  if (thread_.joinable()) thread_.join();
  logger::log_info("watcher stopped");
}

// ── close_all_sessions
// ────────────────────────────────────────────────────────

void Watcher::close_all_sessions(const std::string& reason) {
  auto now = std::time(nullptr);
  int count = static_cast<int>(active_sessions_.size());
  for (auto& [rule_id, pair] : active_sessions_) {
    db_->close_session(pair.first, now, reason);
  }
  active_sessions_.clear();
  if (count > 0) {
    logger::log_info("closed {} session(s), reason='{}'", count, reason);
  }
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

// ── notify_locked_app_to_UI
// ──────────────────────────────────────────────────
//
// Spawns AppLocker.exe --popup so the user sees a styled notification.
// locktime-svc.exe is at: <install>\resources\bin\locktime-svc.exe
// AppLocker.exe is at:    <install>\AppLocker.exe  (three levels up)
//
// If AppLocker is already running its single-instance lock will forward the
// --popup argv to the live process via the second-instance event, so only
// one Electron process ever handles the popup.  If it is not running a fresh
// instance starts in popup-only mode and quits when the user dismisses it.

void Watcher::notify_locked_app_to_UI(const std::string& exe_name,
                                      const std::string& rule_name,
                                      const std::string& reason,
                                      const std::string& next_unlock_time) {
  wchar_t self_path[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, self_path, MAX_PATH);
  std::wstring install_dir(self_path);
  for (int up = 0; up < 3; ++up) {
    auto sep = install_dir.rfind(L'\\');
    if (sep == std::wstring::npos) break;
    install_dir = install_dir.substr(0, sep);
  }
  std::wstring electron_exe = install_dir + L"\\AppLocker.exe";

  auto to_wide = [](const std::string& s) -> std::wstring {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(static_cast<std::size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
    if (!w.empty() && w.back() == L'\0') w.pop_back();
    return w;
  };

  auto quoted_arg = [](const wchar_t* flag,
                       const std::wstring& val) -> std::wstring {
    if (val.empty()) return {};
    return std::wstring(L" \"") + flag + L"=" + val + L"\"";
  };

  std::wstring cmd = L"\"" + electron_exe + L"\" --popup";
  cmd += quoted_arg(L"--app-name", to_wide(exe_name));
  cmd += quoted_arg(L"--rule-name", to_wide(rule_name));
  cmd += quoted_arg(L"--reason", to_wide(reason));
  cmd += quoted_arg(L"--next-unlock", to_wide(next_unlock_time));

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                     DETACHED_PROCESS, nullptr, nullptr, &si, &pi)) {
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  } else {
    logger::log_warning(
        "notify_locked_app_to_UI: failed to spawn AppLocker.exe (err={})",
        GetLastError());
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
        logger::log_info("session opened: rule='{}' exe='{}' pid={}", rule.name,
                         rule.exe_name, pid);
      }
      // If app stopped, close session.
      if (!is_running &&
          active_sessions_.find(rule.id) != active_sessions_.end()) {
        auto& [sid, _pid] = active_sessions_[rule.id];
        db_->close_session(sid, now, "stopped");
        active_sessions_.erase(rule.id);
        logger::log_info("session closed: rule='{}' exe='{}' reason=stopped",
                         rule.name, rule.exe_name);
      }
    } else if (status.status == "locked") {
      // App should be blocked — terminate if running.
      if (is_running) {
        std::string next_unlock_str;
        if (status.next_unlock_at) {
          next_unlock_str = utils::format_iso8601(*status.next_unlock_at);
        }
        notify_locked_app_to_UI(rule.exe_name, rule.name, status.reason,
                                next_unlock_str);
        terminate_process(pid);
        db_->insert_audit(
            "watcher_kill", rule.id,
            "pid=" + std::to_string(pid) + " reason=" + status.reason);
        logger::log_warning(
            "process killed: rule='{}' exe='{}' pid={} reason='{}'", rule.name,
            rule.exe_name, pid, status.reason);
      }
      // Close any open session.
      if (active_sessions_.find(rule.id) != active_sessions_.end()) {
        auto& [sid, _pid] = active_sessions_[rule.id];
        db_->close_session(sid, now, "locked_" + status.reason);
        active_sessions_.erase(rule.id);
        logger::log_info("session closed: rule='{}' exe='{}' reason=locked_{}",
                         rule.name, rule.exe_name, status.reason);
      }
    }
  }
}

}  // namespace locktime
#endif  // _WIN32
