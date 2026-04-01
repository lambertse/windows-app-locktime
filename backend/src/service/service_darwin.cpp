#ifndef _WIN32
#include <ibridger/rpc/server.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <system_error>

#include "common/constants.h"
#include "common/utils.h"
#include "db/database.h"
#include "rpc/locktime_service.h"
#include "service_manager.h"
#include "watcher/watcher.h"

// macOS launchd plist path for system daemon
static constexpr const char* kLaunchdPlistPath =
    "/Library/LaunchDaemons/com.lambertse.locktime.plist";

namespace locktime {

// ── Signal handling
// ───────────────────────────────────────────────────────────

static std::atomic<bool> g_should_stop{false};

static void signal_handler(int /*sig*/) { g_should_stop = true; }

// ── run_service
// ───────────────────────────────────────────────────────────────

int run_service() {
  // Install signal handlers
  struct sigaction sa{};
  sa.sa_handler = signal_handler;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;
  sigaction(SIGTERM, &sa, nullptr);
  sigaction(SIGINT, &sa, nullptr);

  std::shared_ptr<Database> db;
  std::unique_ptr<Watcher> watcher;
  std::unique_ptr<ibridger::rpc::Server> rpc_server;

  try {
    db = std::make_shared<Database>(kDbPath);
    db->crash_recovery(std::time(nullptr));

    auto started_at = std::chrono::steady_clock::now();
    auto svc = std::make_shared<LockTimeService>(db, started_at);

    ibridger::rpc::ServerConfig rpc_cfg;
    rpc_cfg.endpoint = kRpcEndpoint;
    rpc_server = std::make_unique<ibridger::rpc::Server>(rpc_cfg);
    rpc_server->register_service(svc);
    rpc_server->start();

    watcher = std::make_unique<Watcher>(db);
    watcher->start();
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "locktime-svc: startup error: %s\n", ex.what());
    return 1;
  }

  // Event loop — sleep until signalled
  while (!g_should_stop) {
    struct timespec ts{1, 0};
    nanosleep(&ts, nullptr);
  }

  // Shutdown
  if (watcher) {
    watcher->close_all_sessions("service_stop");
    watcher->stop();
  }
  if (rpc_server) {
    rpc_server->stop();
  }

  return 0;
}

// ── install_service
// ───────────────────────────────────────────────────────────

std::error_code install_service(const std::string& exe_path) {
  // Write a launchd plist
  std::string plist =
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"\n"
      "  \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
      "<plist version=\"1.0\">\n"
      "<dict>\n"
      "  <key>Label</key>\n"
      "  <string>" +
      std::string(kServiceName) +
      "</string>\n"
      "  <key>ProgramArguments</key>\n"
      "  <array>\n"
      "    <string>" +
      exe_path +
      "</string>\n"
      "    <string>--run</string>\n"
      "  </array>\n"
      "  <key>RunAtLoad</key><true/>\n"
      "  <key>KeepAlive</key><true/>\n"
      "  <key>StandardErrorPath</key>\n"
      "  <string>/Library/Logs/locktime.log</string>\n"
      "  <key>StandardOutPath</key>\n"
      "  <string>/Library/Logs/locktime.log</string>\n"
      "</dict>\n"
      "</plist>\n";

  std::ofstream f(kLaunchdPlistPath);
  if (!f) {
    return std::error_code(errno, std::generic_category());
  }
  f << plist;
  f.close();

  // Load via launchctl
  int rc =
      std::system(("launchctl load " + std::string(kLaunchdPlistPath)).c_str());
  if (rc != 0) {
    return std::error_code(rc, std::generic_category());
  }
  return {};
}

// ── uninstall_service
// ─────────────────────────────────────────────────────────

std::error_code uninstall_service() {
  // Unload from launchd
  std::system(("launchctl unload " + std::string(kLaunchdPlistPath)).c_str());

  // Remove plist file
  if (std::remove(kLaunchdPlistPath) != 0 && errno != ENOENT) {
    return std::error_code(errno, std::generic_category());
  }
  return {};
}

}  // namespace locktime
#endif  // !_WIN32
