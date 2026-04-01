#pragma once
#include <string>
#include <system_error>

namespace locktime {

/// Install the service into the OS service manager.
/// On Windows: registers with SCM as an auto-start service.
/// On macOS: installs the launchd plist.
std::error_code install_service(const std::string& exe_path);

/// Remove the service from the OS service manager.
std::error_code uninstall_service();

/// Run the service event loop.
/// On Windows: calls StartServiceCtrlDispatcher, returns when service stops.
/// On macOS: runs an event loop with signal handling (launchd keeps it alive).
int run_service();

}  // namespace locktime
