#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <ibridger/rpc/server.h>
#include <windows.h>

#include <chrono>
#include <memory>
#include <string>
#include <system_error>

#include "common/constants.h"
#include "common/utils.h"
#include "db/database.h"
#include "rpc/locktime_service.h"
#include "service_manager.h"
#include "watcher/watcher.h"

namespace locktime {

// ── Global state required by SCM callbacks
// ────────────────────────────────────

static std::shared_ptr<Database> g_db;
static std::unique_ptr<Watcher> g_watcher;
static std::unique_ptr<ibridger::rpc::Server> g_rpc_server;
static SERVICE_STATUS_HANDLE g_svc_handle = nullptr;
static HANDLE g_stop_event = nullptr;
static SERVICE_STATUS g_svc_status{};

static void report_status(DWORD state, DWORD exit_code = NO_ERROR,
                          DWORD wait_hint = 0) {
  g_svc_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_svc_status.dwCurrentState = state;
  g_svc_status.dwControlsAccepted =
      (state == SERVICE_RUNNING)
          ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN)
          : 0;
  g_svc_status.dwWin32ExitCode = exit_code;
  g_svc_status.dwServiceSpecificExitCode = 0;
  g_svc_status.dwCheckPoint = 0;
  g_svc_status.dwWaitHint = wait_hint;
  SetServiceStatus(g_svc_handle, &g_svc_status);
}

// ── ServiceCtrl
// ───────────────────────────────────────────────────────────────

static void WINAPI ServiceCtrl(DWORD ctrl) {
  switch (ctrl) {
    case SERVICE_CONTROL_STOP:
    case SERVICE_CONTROL_SHUTDOWN:
      report_status(SERVICE_STOP_PENDING, NO_ERROR, 5000);
      SetEvent(g_stop_event);
      break;
    default:
      break;
  }
}

// ── ServiceMain
// ───────────────────────────────────────────────────────────────

static void WINAPI ServiceMain(DWORD /*argc*/, LPWSTR* /*argv*/) {
  // Register control handler
  {
    std::wstring svc_name_w;
    int len = MultiByteToWideChar(CP_UTF8, 0, kServiceName, -1, nullptr, 0);
    svc_name_w.resize(static_cast<std::size_t>(len));
    MultiByteToWideChar(CP_UTF8, 0, kServiceName, -1, svc_name_w.data(), len);
    g_svc_handle = RegisterServiceCtrlHandlerW(svc_name_w.c_str(), ServiceCtrl);
  }
  if (!g_svc_handle) return;

  g_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_stop_event) return;

  report_status(SERVICE_START_PENDING, NO_ERROR, 5000);

  // Initialise
  try {
    g_db = std::make_shared<Database>(kDbPath);
    g_db->crash_recovery(std::time(nullptr));

    auto started_at = std::chrono::steady_clock::now();

    auto svc = std::make_shared<LockTimeService>(g_db, started_at);

    ibridger::rpc::ServerConfig rpc_cfg;
    rpc_cfg.endpoint = kRpcEndpoint;
    g_rpc_server = std::make_unique<ibridger::rpc::Server>(rpc_cfg);
    g_rpc_server->register_service(svc);
    g_rpc_server->start();

    g_watcher = std::make_unique<Watcher>(g_db);
    g_watcher->start();
  } catch (...) {
    report_status(SERVICE_STOPPED, ERROR_EXCEPTION_IN_SERVICE);
    return;
  }

  report_status(SERVICE_RUNNING);

  // Wait for stop signal
  WaitForSingleObject(g_stop_event, INFINITE);

  report_status(SERVICE_STOP_PENDING, NO_ERROR, 5000);

  // Shutdown
  if (g_watcher) {
    g_watcher->close_all_sessions("service_stop");
    g_watcher->stop();
    g_watcher.reset();
  }
  if (g_rpc_server) {
    g_rpc_server->stop();
    g_rpc_server.reset();
  }
  g_db.reset();

  CloseHandle(g_stop_event);
  g_stop_event = nullptr;

  report_status(SERVICE_STOPPED);
}

// ── Public API
// ────────────────────────────────────────────────────────────────

int run_service() {
  std::wstring svc_name_w;
  {
    int len = MultiByteToWideChar(CP_UTF8, 0, kServiceName, -1, nullptr, 0);
    svc_name_w.resize(static_cast<std::size_t>(len));
    MultiByteToWideChar(CP_UTF8, 0, kServiceName, -1, svc_name_w.data(), len);
  }

  SERVICE_TABLE_ENTRYW table[] = {{svc_name_w.data(), ServiceMain},
                                  {nullptr, nullptr}};
  StartServiceCtrlDispatcherW(table);
  return 0;
}

std::error_code install_service(const std::string& exe_path) {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
  if (!scm) {
    return std::error_code(static_cast<int>(GetLastError()),
                           std::system_category());
  }

  // Convert strings to wide
  std::wstring svc_name_w, svc_display_w, exe_path_w;
  auto to_wide = [](const std::string& s) -> std::wstring {
    int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(static_cast<std::size_t>(len), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), len);
    return w;
  };

  svc_name_w = to_wide(kServiceName);
  svc_display_w = to_wide("AppLocker Service");
  exe_path_w = to_wide(exe_path);

  SC_HANDLE svc = CreateServiceW(scm, svc_name_w.c_str(), svc_display_w.c_str(),
                                 SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS,
                                 SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
                                 exe_path_w.c_str(),
                                 nullptr,  // load order group
                                 nullptr,  // tag id
                                 nullptr,  // dependencies
                                 nullptr,  // service account (LocalSystem)
                                 nullptr   // password
  );

  if (!svc) {
    DWORD err = GetLastError();
    CloseServiceHandle(scm);
    return std::error_code(static_cast<int>(err), std::system_category());
  }

  // Start immediately
  StartServiceW(svc, 0, nullptr);

  CloseServiceHandle(svc);
  CloseServiceHandle(scm);
  return {};
}

std::error_code uninstall_service() {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
  if (!scm) {
    return std::error_code(static_cast<int>(GetLastError()),
                           std::system_category());
  }

  std::wstring svc_name_w;
  {
    int len = MultiByteToWideChar(CP_UTF8, 0, kServiceName, -1, nullptr, 0);
    svc_name_w.resize(static_cast<std::size_t>(len));
    MultiByteToWideChar(CP_UTF8, 0, kServiceName, -1, svc_name_w.data(), len);
  }

  SC_HANDLE svc = OpenServiceW(scm, svc_name_w.c_str(), SERVICE_STOP | DELETE);
  if (!svc) {
    DWORD err = GetLastError();
    CloseServiceHandle(scm);
    return std::error_code(static_cast<int>(err), std::system_category());
  }

  // Stop the service first
  SERVICE_STATUS ss{};
  ControlService(svc, SERVICE_CONTROL_STOP, &ss);

  DeleteService(svc);
  CloseServiceHandle(svc);
  CloseServiceHandle(scm);
  return {};
}

}  // namespace locktime
#endif  // _WIN32
