#include <filesystem>
#ifndef _WIN32
#include <libproc.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <sys/proc_info.h>
#include <sys/types.h>

#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>

#include "common/constants.h"
#include "common/logger.h"
#include "common/utils.h"
#include "engine/engine.h"
#include "watcher.h"

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

  // First call to get the number of PIDs
  int n = proc_listpids(PROC_ALL_PIDS, 0, nullptr, 0);
  if (n <= 0) return result;

  std::vector<pid_t> pids(static_cast<std::size_t>(n));
  n = proc_listpids(PROC_ALL_PIDS, 0, pids.data(),
                    static_cast<int>(pids.size() * sizeof(pid_t)));
  if (n <= 0) return result;

  int count = n / static_cast<int>(sizeof(pid_t));
  pids.resize(static_cast<std::size_t>(count));

  for (pid_t pid : pids) {
    if (pid == 0) continue;

    char path[PROC_PIDPATHINFO_MAXSIZE]{};
    int ret = proc_pidpath(pid, path, sizeof(path));
    if (ret <= 0) continue;

    ProcessEntry entry;
    entry.pid = static_cast<int>(pid);
    entry.full_path = path;

    // Extract exe_name from path
    std::string fp = path;
    auto slash = fp.rfind('/');
    entry.exe_name = (slash != std::string::npos) ? fp.substr(slash + 1) : fp;

    result.push_back(std::move(entry));
  }

  return result;
}

// ── terminate_process
// ─────────────────────────────────────────────────────────

void Watcher::terminate_process(int pid) { kill(pid, SIGTERM); }

// ── notify_locked_app_to_UI
// ──────────────────────────────────────────────────
//
// Spawns AppLocker (Electron) with --popup so the user sees a styled
// notification.  locktime-svc is at:
//   <app>.app/Contents/Resources/bin/locktime-svc
// The Electron binary is at:
//   <app>.app/Contents/MacOS/AppLocker
// Navigate three levels up from our own path, then into MacOS/.
//
// Same single-instance logic applies as on Windows: if AppLocker is already
// running it receives the popup via the second-instance event (1 process);
// otherwise a fresh popup-only instance starts (2 processes).

void Watcher::notify_locked_app_to_UI(const std::string& exe_name,
                                      const std::string& rule_name,
                                      const std::string& reason,
                                      const std::string& next_unlock_time) {
#ifdef BUILD_DEVELOPMENT
  std::string electron_bin =
      "/Users/tri.le/src/opensource/lambertse/app-locktime/desktop/release/"
      "mac-arm64/AppLocker.app/Contents/MacOS/AppLocker";
#else
  char self_path[PATH_MAX] = {};
  uint32_t size = sizeof(self_path);
  if (_NSGetExecutablePath(self_path, &size) != 0) return;

  std::string install_dir(self_path);
  for (int up = 0; up < 3; ++up) {
    auto sep = install_dir.rfind('/');
    if (sep == std::string::npos) break;
    install_dir = install_dir.substr(0, sep);
  }
  std::string electron_bin = install_dir + "/MacOS/AppLocker";
#endif
  // Build argv for posix_spawn — each value-arg is a single token.
  auto make_arg = [](const std::string& flag,
                     const std::string& val) -> std::string {
    return flag + "=" + val;
  };

  std::vector<std::string> arg_storage;
  arg_storage.push_back(electron_bin);
  arg_storage.push_back("--popup");
  if (!exe_name.empty())
    arg_storage.push_back(make_arg("--app-name", exe_name));
  if (!rule_name.empty())
    arg_storage.push_back(make_arg("--rule-name", rule_name));
  if (!reason.empty()) arg_storage.push_back(make_arg("--reason", reason));
  if (!next_unlock_time.empty())
    arg_storage.push_back(make_arg("--next-unlock", next_unlock_time));

  std::vector<char*> argv;
  for (auto& s : arg_storage) argv.push_back(const_cast<char*>(s.c_str()));
  argv.push_back(nullptr);

  pid_t child_pid = 0;
  if (std::filesystem::exists(electron_bin)) {
    std::cout << "Spawning Electron popup: " << electron_bin << std::endl;
  } else {
    std::cout << "Electron binary not found at: " << electron_bin << std::endl;
    return;
  }
  // Pass nullptr for envp — child inherits the parent's environment.
  int rc = posix_spawn(&child_pid, electron_bin.c_str(), nullptr, nullptr,
                       argv.data(), nullptr);
  if (rc != 0) {
    logger::log_warning("notify_locked_app_to_UI: posix_spawn failed (rc={})",
                        rc);
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

  // Build lower-case exe_name → pid map
  std::map<std::string, int> running_map;
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
      if (is_running &&
          active_sessions_.find(rule.id) == active_sessions_.end()) {
        int64_t sid = db_->open_session(rule.id, pid, now);
        active_sessions_[rule.id] = {sid, pid};
        logger::log_info("session opened: rule='{}' exe='{}' pid={}", rule.name,
                         rule.exe_name, pid);
      }
      if (!is_running &&
          active_sessions_.find(rule.id) != active_sessions_.end()) {
        auto& [sid, _pid] = active_sessions_[rule.id];
        db_->close_session(sid, now, "stopped");
        active_sessions_.erase(rule.id);
        logger::log_info("session closed: rule='{}' exe='{}' reason=stopped",
                         rule.name, rule.exe_name);
      }
    } else if (status.status == "locked") {
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
#endif  // !_WIN32
