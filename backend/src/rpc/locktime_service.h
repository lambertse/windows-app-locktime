#pragma once
#include <ibridger/sdk/service_base.h>

#include <chrono>
#include <memory>
#include <string>
#include <system_error>
#include <utility>

#include "db/database.h"

// Forward-declare generated proto type to avoid including locktime.pb.h in this
// header.
namespace locktime {
namespace rpc {
class Rule;
}
}  // namespace locktime

namespace locktime {

class LockTimeService : public ibridger::sdk::ServiceBase {
 public:
  LockTimeService(std::shared_ptr<Database> db,
                  std::chrono::steady_clock::time_point started_at);

  std::string name() const override { return "locktime.LockTimeService"; }

 private:
  std::shared_ptr<Database> db_;
  std::chrono::steady_clock::time_point started_at_;

  // ── RPC handlers ────────────────────────────────────────────────────────
  std::pair<std::string, std::error_code> handle_get_status(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_list_rules(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_rule(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_create_rule(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_update_rule(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_patch_rule(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_delete_rule(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_grant_override(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_revoke_override(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_usage_today(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_usage_week(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_block_attempts(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_processes(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_get_config(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_update_config(
      const std::string& payload);
  std::pair<std::string, std::error_code> handle_check_app(
      const std::string& payload);

  // ── Helpers ──────────────────────────────────────────────────────────────
  // Convert internal Rule to proto Rule
  static void fill_proto_rule(const locktime::Rule& r,
                              ::locktime::rpc::Rule* proto);

#ifdef _WIN32
  static void set_ifeo(const std::string& exe_name,
                       const std::string& blocker_path);
  static void clear_ifeo(const std::string& exe_name);
#endif
};

}  // namespace locktime
