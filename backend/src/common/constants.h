#pragma once
#include <string>

namespace locktime {

#ifdef _WIN32
constexpr const char* kRpcEndpoint = "\\\\.\\pipe\\locktime-svc";
constexpr const char* kDbPath = "C:\\ProgramData\\AppLocker\\applocker.db";
constexpr const char* kBlockerPath = "C:\\ProgramData\\AppLocker\\blocker.exe";
constexpr const char* kServiceName = "AppLockerSvc";
constexpr const char* kDefaultLogFile =
    ;  // For build failed, will handle later
#else
constexpr const char* kRpcEndpoint = "/tmp/locktime-svc.sock";

#ifdef BUILD_DEVELOPMENT
constexpr const char* kDbPath = "/tmp/AppLocker/applocker.db";
#else
constexpr const char* kDbPath =
    "/Library/Application Support/AppLocker/applocker.db";
#endif

constexpr const char* kServiceName = "com.lambertse.locktime";
#endif

constexpr const char* kVersion = "1.0.0";
constexpr int kWatcherPollMs = 1000;
constexpr const char* kDefaultLogFile = "/tmp/locktime_be.log";
}  // namespace locktime
