#include <cstdio>
#include <string>

#include "service/service_manager.h"

int main(int argc, char* argv[]) {
  std::string cmd = (argc > 1) ? argv[1] : "";

  if (cmd == "--install") {
    std::string exe_path = (argc > 0) ? argv[0] : "locktime-svc";
    auto ec = locktime::install_service(exe_path);
    if (ec) {
      std::fprintf(stderr, "install failed: %s\n", ec.message().c_str());
      return 1;
    }
    std::fprintf(stdout, "Service installed successfully.\n");
    return 0;
  }

  if (cmd == "--uninstall") {
    auto ec = locktime::uninstall_service();
    if (ec) {
      std::fprintf(stderr, "uninstall failed: %s\n", ec.message().c_str());
      return 1;
    }
    std::fprintf(stdout, "Service uninstalled successfully.\n");
    return 0;
  }

  if (cmd == "--run" || cmd.empty()) {
    return locktime::run_service();
  }

  std::fprintf(stderr, "Usage: locktime-svc [--install|--uninstall|--run]\n");
  return 1;
}
