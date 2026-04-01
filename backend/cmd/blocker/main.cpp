// blocker.cpp — Windows IFEO debugger stub
//
// Invoked by Windows as: blocker.exe <target_exe_path> [args...]
// when the target exe has IFEO "Debugger" set to this binary.
//
// Logic:
//   1. Parse command line to extract target exe path and original arguments.
//   2. Connect to locktime-svc via iBridger named pipe.
//   3. Call CheckApp(exe_path).
//   4. If allowed  → CreateProcess(target, original_args) and exit 0.
//   5. If blocked  → show MessageBox explaining the block, exit 0.
//   6. If unreachable → fail-open: launch the target anyway.

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <ibridger/sdk/client_stub.h>
#include <windows.h>

#include <chrono>
#include <string>
#include <vector>

#include "common/constants.h"
#include "locktime.pb.h"

// ── Helpers
// ───────────────────────────────────────────────────────────────────

static std::wstring utf8_to_wide(const std::string& s) {
  if (s.empty()) return {};
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(static_cast<std::size_t>(len), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), len);
  return w;
}

static std::string wide_to_utf8(const wchar_t* w) {
  if (!w) return {};
  int len =
      WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<std::size_t>(len), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], len, nullptr, nullptr);
  if (!s.empty() && s.back() == '\0') s.pop_back();
  return s;
}

// Launch a process using the original command line (first arg is the real exe).
static void launch_target(const std::wstring& cmd_line) {
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::wstring cl = cmd_line;  // CreateProcessW may modify it
  CreateProcessW(nullptr, cl.data(), nullptr, nullptr, FALSE, 0, nullptr,
                 nullptr, &si, &pi);
  if (pi.hProcess) CloseHandle(pi.hProcess);
  if (pi.hThread) CloseHandle(pi.hThread);
}

// ── WinMain
// ───────────────────────────────────────────────────────────────────

int WINAPI WinMain(HINSTANCE /*hInstance*/, HINSTANCE /*hPrev*/,
                   LPSTR /*lpCmdLine*/, int /*nCmdShow*/) {
  // Get the full command line (wide)
  LPWSTR full_cmd = GetCommandLineW();

  // Parse: first token is this blocker.exe, rest is the real target + args
  int nargs = 0;
  LPWSTR* args = CommandLineToArgvW(full_cmd, &nargs);
  if (!args || nargs < 2) {
    // Nothing to do
    if (args) LocalFree(args);
    return 0;
  }

  // Target exe path is argv[1]; reconstruct target command line from argv[1..n]
  std::wstring target_path = args[1];
  std::wstring target_cmdline;
  for (int i = 1; i < nargs; ++i) {
    if (i > 1) target_cmdline += L" ";
    // Re-quote args that contain spaces
    std::wstring arg = args[i];
    if (arg.find(L' ') != std::wstring::npos) {
      target_cmdline += L"\"" + arg + L"\"";
    } else {
      target_cmdline += arg;
    }
  }
  LocalFree(args);

  std::string exe_path_utf8 = wide_to_utf8(target_path.c_str());

  // ── Try to connect to locktime-svc ────────────────────────────────────────

  bool allowed = true;  // fail-open default
  std::string block_reason;
  std::string next_unlock;
  std::string rule_name;

  try {
    using namespace std::chrono_literals;

    ibridger::sdk::ClientStub client(locktime::kRpcEndpoint, 2s);

    ::locktime::CheckAppRequest req;
    req.set_exe_path(exe_path_utf8);

    std::string req_bytes;
    req.SerializeToString(&req_bytes);

    auto [resp_bytes, ec] =
        client.call("locktime.LockTimeService", "CheckApp", req_bytes);

    if (!ec) {
      ::locktime::CheckAppResponse resp;
      if (resp.ParseFromString(resp_bytes)) {
        allowed = resp.allowed();
        block_reason = resp.reason();
        next_unlock = resp.next_unlock_at();
        rule_name = resp.rule_name();
      }
    }
  } catch (...) {
    // Service unreachable — fail-open
    allowed = true;
  }

  if (allowed) {
    launch_target(target_cmdline);
    return 0;
  }

  // ── Show block message ─────────────────────────────────────────────────────
  std::wstring msg = L"AppLocker blocked this application";
  if (!rule_name.empty()) {
    msg += L"\n\nRule: " + utf8_to_wide(rule_name);
  }
  if (!block_reason.empty()) {
    msg += L"\nReason: " + utf8_to_wide(block_reason);
  }
  if (!next_unlock.empty()) {
    msg += L"\nAvailable from: " + utf8_to_wide(next_unlock);
  }

  MessageBoxW(nullptr, msg.c_str(), L"AppLocker",
              MB_OK | MB_ICONINFORMATION | MB_TOPMOST);
  return 0;
}

#else
// Non-Windows stub (should never be compiled, blocker is Windows-only)
int main() { return 0; }
#endif  // _WIN32
