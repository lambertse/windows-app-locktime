#ifndef _WIN32
#include <libproc.h>
#include <signal.h>
#include <sys/proc_info.h>
#include <sys/types.h>

#include <chrono>
#include <cstring>
#include <thread>

#include "common/constants.h"
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
      }
      if (!is_running &&
          active_sessions_.find(rule.id) != active_sessions_.end()) {
        auto& [sid, _pid] = active_sessions_[rule.id];
        db_->close_session(sid, now, "stopped");
        active_sessions_.erase(rule.id);
      }
    } else if (status.status == "locked") {
      if (is_running) {
        terminate_process(pid);
        db_->insert_audit(
            "watcher_kill", rule.id,
            "pid=" + std::to_string(pid) + " reason=" + status.reason);
      }
      if (active_sessions_.find(rule.id) != active_sessions_.end()) {
        auto& [sid, _pid] = active_sessions_[rule.id];
        db_->close_session(sid, now, "locked_" + status.reason);
        active_sessions_.erase(rule.id);
      }
    }
  }
}

}  // namespace locktime
#endif  // !_WIN32
