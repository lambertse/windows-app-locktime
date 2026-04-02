# Backend Architecture — C++ Rewrite

This document describes the target architecture for the C++ backend that replaces the Go backend.
It is intended as an implementation guide — follow each phase in order.

---

## Overview

The backend is a **C++ Windows Service** (and macOS LaunchDaemon) that:
- Runs as a system-privileged background process
- Exposes an **iBridger RPC server** over a Named Pipe (Windows) or Unix socket (macOS)
- Manages SQLite persistence for rules, schedules, and usage
- Enforces app blocks via IFEO registry keys (Windows) or SIGTERM (macOS)
- Spawns a process watcher that polls running processes every second

---

## Directory Layout

```
backend/
├── CMakeLists.txt                  # Top-level build file
├── cmake/
│   └── CompileProto.cmake          # Helper to run protoc
├── third_party/
│   └── sqlite/
│       ├── sqlite3.h               # SQLite amalgamation (download separately)
│       └── sqlite3.c
├── proto/
│   └── locktime/
│       └── locktime.proto          # Symlink or copy from repo root proto/
├── generated/                      # protoc output (gitignored)
│   ├── locktime.pb.h
│   └── locktime.pb.cc
├── src/
│   ├── common/
│   │   ├── constants.h             # Endpoint name, DB path, version string
│   │   └── utils.h/.cpp            # UUID generation, time formatting helpers
│   ├── engine/
│   │   ├── engine.h
│   │   └── engine.cpp              # Rule evaluation (pure logic, no I/O)
│   ├── db/
│   │   ├── database.h
│   │   └── database.cpp            # SQLite RAII wrapper + all queries
│   ├── rpc/
│   │   ├── locktime_service.h
│   │   └── locktime_service.cpp    # iBridger IService implementation
│   ├── watcher/
│   │   ├── watcher.h               # Abstract IWatcher interface
│   │   ├── watcher_windows.cpp     # Win32 CreateToolhelp32Snapshot loop
│   │   └── watcher_darwin.cpp      # macOS proc_listpids / sysctl loop
│   └── service/
│       ├── service_manager.h       # Abstract IServiceManager interface
│       ├── service_windows.cpp     # WIN32 SERVICE_MAIN_FUNCTION, SCM integration
│       └── service_darwin.cpp      # macOS launchd / signal-based lifecycle
└── cmd/
    ├── locktime-svc/
    │   └── main.cpp                # Entry point: --install | --uninstall | --run
    └── blocker/
        └── main.cpp                # IFEO stub: connects via iBridger, checks, launches/blocks
```

---

## Dependencies

| Dependency | Version | How to get |
|---|---|---|
| **CMake** | 3.20+ | System install |
| **C++ compiler** | MSVC 2022 / Clang 15+ / GCC 12+ | System install |
| **protobuf** | 3.21+ | `FetchContent` or vcpkg |
| **iBridger** | master | `FetchContent` from `github.com/lambertse/iBridger` |
| **SQLite3** | 3.46+ | Bundle amalgamation in `third_party/sqlite/` |

### Recommended CMake dependency setup

```cmake
cmake_minimum_required(VERSION 3.20)
project(locktime VERSION 1.0.0 LANGUAGES CXX C)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# ── Protobuf ──────────────────────────────────────────────────────────────────
FetchContent_Declare(
  protobuf
  GIT_REPOSITORY https://github.com/protocolbuffers/protobuf.git
  GIT_TAG        v25.3
  GIT_SHALLOW    TRUE
)
set(protobuf_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(protobuf)

# ── iBridger ─────────────────────────────────────────────────────────────────
FetchContent_Declare(
  ibridger
  GIT_REPOSITORY https://github.com/lambertse/iBridger.git
  GIT_TAG        master
)
set(IBRIDGER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(IBRIDGER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ibridger)

# ── SQLite3 (amalgamation, bundled) ──────────────────────────────────────────
add_library(sqlite3 STATIC third_party/sqlite/sqlite3.c)
target_include_directories(sqlite3 PUBLIC third_party/sqlite)
target_compile_definitions(sqlite3 PUBLIC SQLITE_THREADSAFE=2)  # Serialized mode

# ── Proto generation ─────────────────────────────────────────────────────────
find_program(PROTOC protoc HINTS ${protobuf_BINARY_DIR})
add_custom_command(
  OUTPUT  generated/locktime.pb.h generated/locktime.pb.cc
  COMMAND ${PROTOC}
          --cpp_out=${CMAKE_CURRENT_SOURCE_DIR}/generated
          --proto_path=${CMAKE_SOURCE_DIR}/../proto
          locktime/locktime.proto
  DEPENDS proto/locktime/locktime.proto
)

# ── Core library (shared by locktime-svc and blocker) ─────────────────────────
add_library(locktime_core STATIC
  src/common/utils.cpp
  src/engine/engine.cpp
  src/db/database.cpp
  src/rpc/locktime_service.cpp
  generated/locktime.pb.cc
)
target_include_directories(locktime_core PUBLIC src generated third_party/sqlite)
target_link_libraries(locktime_core PUBLIC
  ibridger::sdk::cpp
  ibridger::core
  protobuf::libprotobuf
  sqlite3
)
if(WIN32)
  target_link_libraries(locktime_core PUBLIC advapi32 user32)
endif()

# ── locktime-svc executable ───────────────────────────────────────────────────
add_executable(locktime-svc cmd/locktime-svc/main.cpp)
if(WIN32)
  target_sources(locktime-svc PRIVATE
    src/watcher/watcher_windows.cpp
    src/service/service_windows.cpp
  )
  set_target_properties(locktime-svc PROPERTIES WIN32_EXECUTABLE TRUE)
else()
  target_sources(locktime-svc PRIVATE
    src/watcher/watcher_darwin.cpp
    src/service/service_darwin.cpp
  )
endif()
target_link_libraries(locktime-svc PRIVATE locktime_core)

# ── blocker executable (Windows only) ────────────────────────────────────────
if(WIN32)
  add_executable(blocker WIN32 cmd/blocker/main.cpp generated/locktime.pb.cc)
  target_include_directories(blocker PRIVATE generated)
  target_link_libraries(blocker PRIVATE ibridger::sdk::cpp protobuf::libprotobuf user32)
endif()
```

---

## Phase-by-Phase Implementation Roadmap

### Phase 1 — Project Skeleton & Build System
**Goal:** `cmake -B build && cmake --build build` succeeds with empty stubs.

1. Create `CMakeLists.txt` as above.
2. Download SQLite amalgamation into `third_party/sqlite/`.
3. Create stub `.cpp` files (empty functions with correct signatures) for all modules.
4. Verify the project compiles on Windows and macOS.

**Deliverables:** Compilable project. Empty executables.

---

### Phase 2 — Common Utilities
**File:** `src/common/constants.h`, `src/common/utils.h/.cpp`

```cpp
// constants.h
#pragma once
#include <string>

namespace locktime {

#ifdef _WIN32
  constexpr const char* kRpcEndpoint = "\\\\.\\pipe\\locktime-svc";
  constexpr const char* kDbPath      = "C:\\ProgramData\\AppLocker\\applocker.db";
  constexpr const char* kBlockerPath = "C:\\ProgramData\\AppLocker\\blocker.exe";
  constexpr const char* kServiceName = "AppLockerSvc";
#else
  constexpr const char* kRpcEndpoint = "/tmp/locktime-svc.sock";
  constexpr const char* kDbPath      = "/Library/Application Support/AppLocker/applocker.db";
  constexpr const char* kServiceName = "com.lambertse.locktime";
#endif

constexpr const char* kVersion     = "1.0.0";
constexpr int         kWatcherPollMs = 1000;

} // namespace locktime
```

```cpp
// utils.h
#pragma once
#include <string>
#include <ctime>

namespace locktime::utils {

std::string generate_uuid();                          // random UUID v4
std::string now_iso8601();                            // current UTC as "YYYY-MM-DDTHH:MM:SSZ"
std::string today_date();                             // "YYYY-MM-DD"
std::string format_iso8601(std::time_t t);
std::time_t parse_iso8601(const std::string& s);     // returns 0 on failure

// HH:MM parsing helpers
bool parse_hhmm(const std::string& s, int& h, int& m);

} // namespace locktime::utils
```

**Notes:**
- UUID: use `<random>` with a custom generator, or `UuidCreate` on Windows (in `rpc.h`).
- ISO-8601 formatting: `strftime` with `%Y-%m-%dT%H:%M:%SZ` in UTC.

---

### Phase 3 — Rule Evaluation Engine
**File:** `src/engine/engine.h/.cpp`

Direct port from Go `internal/engine/engine.go`. Pure logic, zero I/O, fully testable.

```cpp
// engine.h
#pragma once
#include <string>
#include <vector>
#include <ctime>
#include <optional>

namespace locktime {

struct Schedule {
  std::string id;
  std::string rule_id;
  std::vector<int> days;    // 0=Sunday..6=Saturday
  std::string allow_start;  // "HH:MM"
  std::string allow_end;    // "HH:MM"
  int warn_before_minutes = 0;
};

struct Rule {
  std::string id, name, exe_name;
  std::string exe_path;     // empty if not set
  std::string match_mode;   // "name" | "path"
  bool enabled = true;
  int daily_limit_minutes = 0;
  bool ifeo_active = false;
  std::vector<Schedule> schedules;
  std::string created_at, updated_at;
};

struct RuleStatus {
  std::string status;              // "locked" | "active" | "disabled"
  std::string reason;              // "outside_schedule" | "daily_limit_reached" | "both" | ""
  std::optional<std::time_t> next_lock_at;
  std::optional<std::time_t> next_unlock_at;
};

// Core functions (all take std::time_t for testability)
bool is_in_window(const std::string& allow_start, const std::string& allow_end, std::time_t now);
bool is_in_schedule(const Schedule& sched, std::time_t now);
bool is_rule_in_allow_window(const std::vector<Schedule>& schedules, std::time_t now);
std::optional<std::time_t> next_unlock_at(const std::vector<Schedule>& schedules, std::time_t now);
std::optional<std::time_t> next_lock_at(const std::vector<Schedule>& schedules, std::time_t now);
RuleStatus compute_rule_status(const Rule& rule, int minutes_used_today, std::time_t now);

} // namespace locktime
```

**Key implementation notes:**
- Overnight window detection: `end_minutes < start_minutes` (e.g. 22:00–08:00).
- For overnight windows, check yesterday's DOW when `now` is in the post-midnight segment.
- `next_occurrence_of(target_dow, hhmm, now)` → next `std::time_t` when that DOW+time occurs.
- All time arithmetic uses `struct tm` / `mktime` with UTC.

---

### Phase 4 — SQLite Database Layer
**File:** `src/db/database.h/.cpp`

RAII wrapper around SQLite with all queries.

```cpp
// database.h
#pragma once
#include "engine/engine.h"
#include <sqlite3.h>
#include <string>
#include <vector>
#include <optional>
#include <memory>
#include <ctime>

namespace locktime {

struct UsageSession {
  int64_t id = 0;
  std::string rule_id;
  std::string date;
  int pid = 0;
  std::string started_at;
  std::string ended_at;      // empty if open
  int duration_minutes = 0;
  std::string terminated_by;
};

struct Override {
  int64_t id = 0;
  std::string rule_id;
  std::string granted_at;
  std::string expires_at;
  int duration_minutes = 0;
  std::string reason;
  bool consumed = false;
};

struct AuditEntry {
  int64_t id = 0;
  std::string ts;
  std::string action;
  std::string entity_id;
  std::string detail;
};

class Database {
public:
  explicit Database(const std::string& path);
  ~Database();

  // Disallow copy; allow move
  Database(const Database&) = delete;
  Database& operator=(const Database&) = delete;

  // ── Rules ──────────────────────────────────────────────────────────────
  std::vector<Rule>  get_rules();
  std::optional<Rule> get_rule_by_id(const std::string& id);
  void create_rule(const Rule& r);
  void update_rule(const Rule& r);
  void patch_rule(const std::string& id, bool hasEnabled, bool enabled,
                  bool hasName, const std::string& name);
  void delete_rule(const std::string& id);
  void set_rule_ifeo_active(const std::string& id, bool active);

  // ── Schedules ─────────────────────────────────────────────────────────
  std::vector<Schedule> get_schedules_for_rule(const std::string& rule_id);
  void create_schedule(const Schedule& s);
  void delete_schedules_for_rule(const std::string& rule_id);

  // ── Usage Sessions ────────────────────────────────────────────────────
  int64_t open_session(const std::string& rule_id, int pid, std::time_t started_at);
  void    close_session(int64_t session_id, std::time_t ended_at, const std::string& terminated_by);
  void    crash_recovery(std::time_t startup_time);
  std::vector<UsageSession> get_open_sessions();
  std::vector<UsageSession> get_sessions_for_date(const std::string& date);
  std::vector<UsageSession> get_sessions(const std::string& rule_id,
                                          const std::string& from, const std::string& to);
  int get_daily_minutes(const std::string& rule_id, const std::string& date, std::time_t now);

  // ── Overrides ─────────────────────────────────────────────────────────
  void create_override(const Override& o);
  std::optional<Override> get_active_override(const std::string& rule_id, std::time_t now);
  bool delete_active_override(const std::string& rule_id, std::time_t now);

  // ── Config ────────────────────────────────────────────────────────────
  std::map<std::string, std::string> get_config();
  void set_config(const std::string& key, const std::string& value);

  // ── Audit Log ─────────────────────────────────────────────────────────
  void insert_audit(const std::string& action,
                    const std::string& entity_id = "",
                    const std::string& detail = "");
  std::vector<AuditEntry> get_audit_attempts(
      const std::string& from, const std::string& to,
      const std::string& rule_id = "", int limit = 100);

private:
  sqlite3* db_ = nullptr;

  void exec(const char* sql);
  void apply_schema();
  void seed_config();
  // Helper: prepare + bind + step + finalize
  void exec_stmt(const std::string& sql, std::function<void(sqlite3_stmt*)> binder = {});
  std::vector<Schedule> load_schedules_for_rule(const std::string& rule_id);
};

} // namespace locktime
```

**Schema** (same as Go, apply via `sqlite3_exec` at open time):
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, exe_name TEXT NOT NULL,
  exe_path TEXT, match_mode TEXT NOT NULL DEFAULT 'name',
  enabled INTEGER NOT NULL DEFAULT 1, daily_limit_minutes INTEGER NOT NULL DEFAULT 0,
  ifeo_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  days TEXT NOT NULL, allow_start TEXT NOT NULL, allow_end TEXT NOT NULL,
  warn_before_minutes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  date TEXT NOT NULL, pid INTEGER, started_at TEXT NOT NULL,
  ended_at TEXT, duration_minutes INTEGER, terminated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_sessions_rule_date ON usage_sessions(rule_id, date);
CREATE TABLE IF NOT EXISTS overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL, duration_minutes INTEGER NOT NULL,
  reason TEXT, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  action TEXT NOT NULL, entity_id TEXT, detail TEXT
);
```

Days field is stored as a JSON array string: `"[0,1,2,3,4]"`. Use `nlohmann/json` or a hand-rolled JSON parser.

---

### Phase 5 — iBridger RPC Service
**File:** `src/rpc/locktime_service.h/.cpp`

Implements `ibridger::rpc::IService` for the `locktime.LockTimeService` service.

```cpp
// locktime_service.h
#pragma once
#include <ibridger/rpc/service.h>
#include <ibridger/sdk/service_base.h>
#include "db/database.h"
#include <memory>
#include <chrono>

namespace locktime {

class LockTimeService : public ibridger::sdk::ServiceBase {
public:
  LockTimeService(std::shared_ptr<Database> db,
                  std::chrono::steady_clock::time_point started_at);

  std::string name() const override { return "locktime.LockTimeService"; }

private:
  std::shared_ptr<Database> db_;
  std::chrono::steady_clock::time_point started_at_;

  // Each method receives raw protobuf bytes, returns raw protobuf bytes.
  // Register them in the constructor via register_method(name, handler).

  std::pair<std::string, std::error_code> handle_get_status(const std::string& payload);
  std::pair<std::string, std::error_code> handle_list_rules(const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_rule(const std::string& payload);
  std::pair<std::string, std::error_code> handle_create_rule(const std::string& payload);
  std::pair<std::string, std::error_code> handle_update_rule(const std::string& payload);
  std::pair<std::string, std::error_code> handle_patch_rule(const std::string& payload);
  std::pair<std::string, std::error_code> handle_delete_rule(const std::string& payload);
  std::pair<std::string, std::error_code> handle_grant_override(const std::string& payload);
  std::pair<std::string, std::error_code> handle_revoke_override(const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_usage_today(const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_usage_week(const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_block_attempts(const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_processes(const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_config(const std::string& payload);
  std::pair<std::string, std::error_code> handle_update_config(const std::string& payload);
  std::pair<std::string, std::error_code> handle_check_app(const std::string& payload);
};

} // namespace locktime
```

**Constructor pattern:**
```cpp
LockTimeService::LockTimeService(...)
    : ServiceBase("locktime.LockTimeService"), db_(db), started_at_(started_at)
{
  register_method("GetStatus",       [this](auto& p){ return handle_get_status(p); });
  register_method("ListRules",       [this](auto& p){ return handle_list_rules(p); });
  // ... register all methods
}
```

**Handler pattern for each method:**
```cpp
std::pair<std::string, std::error_code>
LockTimeService::handle_get_status(const std::string& payload) {
  // 1. Deserialize request
  locktime::GetStatusRequest req;
  if (!req.ParseFromString(payload)) {
    return {{}, make_error_code(ibridger::common::Error::serialization_error)};
  }
  // 2. Business logic
  auto rules = db_->get_rules();
  auto now = std::time(nullptr);
  // ... build response proto
  locktime::GetStatusResponse resp;
  // ... fill fields
  // 3. Serialize response
  std::string out;
  resp.SerializeToString(&out);
  return {out, {}};
}
```

**IFEO operations** (Windows only, call from within handlers):
```cpp
// In handle_create_rule / handle_update_rule / handle_delete_rule
#ifdef _WIN32
  void set_ifeo(const std::string& exe_name, const std::string& blocker_path);
  void clear_ifeo(const std::string& exe_name);
#endif
```

Use `RegCreateKeyExW` / `RegSetValueExW` to write:
```
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\<exe_name>
  Debugger = "C:\ProgramData\AppLocker\blocker.exe"
```

---

### Phase 6 — Process Watcher
**File:** `src/watcher/watcher.h`, `watcher_windows.cpp`, `watcher_darwin.cpp`

```cpp
// watcher.h
#pragma once
#include "db/database.h"
#include <memory>
#include <thread>
#include <atomic>

namespace locktime {

struct ProcessEntry {
  int pid;
  std::string exe_name;
  std::string full_path;
};

class Watcher {
public:
  explicit Watcher(std::shared_ptr<Database> db);
  ~Watcher();

  void start();
  void stop();
  void close_all_sessions(const std::string& reason);

  // Platform-specific: list currently running processes
  std::vector<ProcessEntry> enumerate_processes();

private:
  std::shared_ptr<Database> db_;
  std::atomic<bool> running_{false};
  std::thread thread_;

  // Session tracking: rule_id → {session_id, pid}
  std::map<std::string, std::pair<int64_t, int>> active_sessions_;

  void poll_loop();
  void reconcile(const std::vector<ProcessEntry>& procs, std::time_t now);

  // Platform-specific enforcement
  void terminate_process(int pid);           // TerminateProcess / kill(SIGTERM)
};

} // namespace locktime
```

**Windows implementation notes** (`watcher_windows.cpp`):
- `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)` → iterate with `Process32FirstW` / `Process32NextW`
- `QueryFullProcessImageNameW` to get full path
- `TerminateProcess(OpenProcess(PROCESS_TERMINATE, FALSE, pid), 1)` to kill
- IFEO reconciliation: call `set_ifeo` / `clear_ifeo` based on rule changes

**macOS implementation notes** (`watcher_darwin.cpp`):
- `proc_listpids(PROC_ALL_PIDS, 0, buf, size)` to get PIDs
- `proc_pidpath(pid, path, sizeof(path))` for full path
- `kill(pid, SIGTERM)` to terminate
- No IFEO equivalent on macOS — watcher is primary enforcement

---

### Phase 7 — Service Manager
**File:** `src/service/service_manager.h`, `service_windows.cpp`, `service_darwin.cpp`

```cpp
// service_manager.h
#pragma once
#include <string>
#include <system_error>

namespace locktime {

// Windows: --install / --uninstall call these
std::error_code install_service(const std::string& exe_path);
std::error_code uninstall_service();

// Called by main() when --run is passed
// On Windows: calls StartServiceCtrlDispatcher, registers ServiceMain
// On macOS: runs the event loop directly (launchd keeps us alive)
int run_service();

} // namespace locktime
```

**Windows `service_windows.cpp` implementation:**
```cpp
// Global state needed by SCM callbacks
static std::shared_ptr<Database> g_db;
static std::unique_ptr<Watcher>  g_watcher;
static ibridger::rpc::Server*    g_rpc_server = nullptr;
static SERVICE_STATUS_HANDLE     g_svc_handle;

void WINAPI ServiceMain(DWORD argc, LPWSTR* argv) {
  g_svc_handle = RegisterServiceCtrlHandlerW(L"AppLockerSvc", ServiceCtrl);
  // Report StartPending
  // Initialize DB, crash recovery, RPC server, watcher
  // Register LockTimeService with RPC server
  // server.start()
  // watcher.start()
  // Report Running
  // WaitForSingleObject(g_stop_event, INFINITE)
  // Report StopPending
  // watcher.stop(), server.stop(), db close
  // Report Stopped
}

void WINAPI ServiceCtrl(DWORD ctrl) {
  if (ctrl == SERVICE_CONTROL_STOP || ctrl == SERVICE_CONTROL_SHUTDOWN) {
    SetEvent(g_stop_event);
  }
}

int run_service() {
  SERVICE_TABLE_ENTRYW table[] = {
    { const_cast<LPWSTR>(L"AppLockerSvc"), ServiceMain },
    { nullptr, nullptr }
  };
  StartServiceCtrlDispatcherW(table);
  return 0;
}
```

**Windows install/uninstall:**
```cpp
std::error_code install_service(const std::string& exe_path) {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
  SC_HANDLE svc = CreateServiceW(scm, L"AppLockerSvc", L"AppLocker",
      SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS,
      SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
      /* binary path */ ..., nullptr, nullptr, nullptr, nullptr, nullptr);
  StartServiceW(svc, 0, nullptr);
  CloseServiceHandle(svc); CloseServiceHandle(scm);
  return {};
}
```

---

### Phase 8 — Main Executables

#### `cmd/locktime-svc/main.cpp`

```cpp
int main(int argc, char* argv[]) {
  std::string cmd = (argc > 1) ? argv[1] : "";

  if (cmd == "--install") {
    auto ec = locktime::install_service(argv[0]);
    return ec ? 1 : 0;
  }
  if (cmd == "--uninstall") {
    auto ec = locktime::uninstall_service();
    return ec ? 1 : 0;
  }
  if (cmd == "--run" || cmd.empty()) {
    return locktime::run_service();
  }
  std::fprintf(stderr, "Usage: locktime-svc [--install|--uninstall|--run]\n");
  return 1;
}
```

#### `cmd/blocker/main.cpp`

```cpp
// Windows IFEO debugger stub
// Invoked as: blocker.exe <target_exe_path> [args...]
// 1. Connect to iBridger server (named pipe)
// 2. Call CheckApp(exe_path)
// 3. If allowed: CreateProcess(target, args...) and exit
// 4. If blocked: MessageBoxW(blocking message) and exit
// 5. If server unavailable: fail-open, launch target

int WINAPI WinMain(...) {
  // Parse command line
  // Connect ibridger::sdk::ClientStub to kRpcEndpoint
  // Call CheckApp
  // Branch on response.allowed()
}
```

---

### Phase 9 — Testing

**Engine tests** (no I/O, no dependencies):
```bash
# In backend/
cmake -B build -DLOCKTIME_BUILD_TESTS=ON
cmake --build build
cd build && ctest
```

Test cases to cover:
- Normal window (08:00–22:00) at various times
- Overnight window (22:00–08:00) before/after midnight
- Overnight window with DOW crossing (23:59 Sunday → 00:01 Monday)
- Daily limit exactly at 0 / at limit / over limit
- Rule disabled
- Empty schedule list (always blocked)
- `next_unlock_at` and `next_lock_at` correctness

**Integration testing:**
- Build both executables
- Run `locktime-svc --run` in foreground
- Run a separate client that connects and makes each RPC call
- Verify responses match expected values

---

### Phase 10 — CI/CD Integration

Replace the Go build steps in `.github/workflows/release.yml`:

```yaml
- name: Setup MSVC
  uses: ilammy/msvc-dev-cmd@v1

- name: Install protobuf (Windows)
  run: choco install protoc

- name: Configure CMake (Windows)
  working-directory: backend
  run: cmake -B build -DCMAKE_BUILD_TYPE=Release

- name: Build (Windows)
  working-directory: backend
  run: cmake --build build --config Release

- name: Copy binaries
  run: |
    cp backend/build/Release/locktime-svc.exe desktop/resources/bin/
    cp backend/build/Release/blocker.exe desktop/resources/bin/
```

---

## Data Flow Summary

```
[Electron Renderer]
       |  window.api.getStatus()  (via contextBridge)
       ↓
[Electron Main Process]
       |  IBridgerClient.call("locktime.LockTimeService", "GetStatus", ...)
       ↓  Named Pipe: \\.\pipe\locktime-svc  (Win32)
       |  Unix socket: /tmp/locktime-svc.sock  (macOS)
       ↓
[locktime-svc (C++ iBridger Server)]
       |  LockTimeService::handle_get_status()
       |  → Database::get_rules() → SQLite
       |  → engine::compute_rule_status() → pure logic
       |  → Watcher::get_running_pids() → platform API
       ↓
[Response serialized to protobuf → back up the chain]
```

---

## Common Pitfalls

- **IFEO keys require SYSTEM privileges.** The service must run as SYSTEM or LocalSystem.
- **Named pipe ACL:** Create the pipe with an appropriate SDDL so the Electron app (running as user) can connect. Use `ConvertStringSecurityDescriptorToSecurityDescriptor` with `"D:(A;;GA;;;WD)"` (world-readable) or restrict to the user SID.
- **SQLite WAL + single writer:** Open with `PRAGMA journal_mode=WAL` and use `SetMaxOpenConns(1)` equivalent — open one `sqlite3*` handle and protect with a `std::mutex`.
- **Overnight windows + DST:** Use UTC throughout. Convert display times in the frontend.
- **blocker.exe must connect quickly:** The user is waiting. Use a short connect timeout (2s) and fail-open if the service is unreachable.
- **Proto field naming:** Use `snake_case` in the proto and map to C++ getter names accordingly (protobuf C++ uses `lower_snake_case` for field accessors).

