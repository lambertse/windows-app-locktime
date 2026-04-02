cmake_minimum_required(VERSION 3.20)
project(locktime VERSION 1.0.0 LANGUAGES CXX C)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON) 
# Default is Debug mode:
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug CACHE STRING "Choose the type of build." FORCE)
  set(CMAKE_C_FLAGS_DEBUG "-O0 -g" CACHE STRING "" FORCE)
  set(CMAKE_CXX_FLAGS_DEBUG "-O0 -g" CACHE STRING "" FORCE)
endif()


# -- Local definition --
if(BUILD_DEVELOPMENT)
  add_compile_definitions(BUILD_DEVELOPMENT)
else()
  add_compile_definitions(BUILD_PRODUCTION)
endif()
#

include(FetchContent)

# ── Protobuf ──────────────────────────────────────────────────────────────────
# Prefer a system/Homebrew installation; fall back to FetchContent for CI.
find_package(protobuf CONFIG QUIET)
if(NOT protobuf_FOUND)
  message(STATUS "protobuf not found via find_package — fetching via FetchContent")
  set(protobuf_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
  set(protobuf_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(protobuf_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(protobuf_INSTALL        OFF CACHE BOOL "" FORCE)
  set(protobuf_WITH_ZLIB      OFF CACHE BOOL "" FORCE)
  # Let protobuf manage its own abseil dependency ("module" avoids package detection issues)
  set(protobuf_ABSL_PROVIDER  "module" CACHE STRING "" FORCE)
  set(ABSL_PROPAGATE_CXX_STD  ON CACHE BOOL "" FORCE)

  FetchContent_Declare(
    protobuf
    GIT_REPOSITORY https://github.com/protocolbuffers/protobuf.git
    GIT_TAG        v28.3
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(protobuf)
else()
  message(STATUS "Using system protobuf: ${protobuf_VERSION}")
endif()

# ── iBridger ─────────────────────────────────────────────────────────────────
FetchContent_Declare(
  ibridger
  GIT_REPOSITORY https://github.com/lambertse/iBridger.git
  GIT_TAG       v0.3.0 
)
set(IBRIDGER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(IBRIDGER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ibridger)

# Declare the spdlog dependency
FetchContent_Declare(
  spdlog
  GIT_REPOSITORY https://github.com/gabime/spdlog.git
  GIT_TAG v1.x 
)
FetchContent_MakeAvailable(spdlog)
#

# ── SQLite3 (amalgamation, bundled) ──────────────────────────────────────────
add_library(sqlite3 STATIC third_party/sqlite/sqlite3.c)
target_include_directories(sqlite3 PUBLIC third_party/sqlite)
target_compile_definitions(sqlite3 PUBLIC SQLITE_THREADSAFE=2)  # Serialized mode

# ── Proto generation ─────────────────────────────────────────────────────────
file(MAKE_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/generated)
add_custom_command(
  OUTPUT  ${CMAKE_CURRENT_BINARY_DIR}/generated/locktime.pb.h
          ${CMAKE_CURRENT_BINARY_DIR}/generated/locktime.pb.cc
  COMMAND $<TARGET_FILE:protobuf::protoc>
          --cpp_out=${CMAKE_CURRENT_BINARY_DIR}/generated
          --proto_path=${CMAKE_CURRENT_SOURCE_DIR}/../proto/locktime
          locktime.proto
  DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/proto/locktime/locktime.proto
          protobuf::protoc
  COMMENT "Generating locktime protobuf sources"
)

# ── Core library (shared by locktime-svc and blocker) ─────────────────────────
add_library(locktime_core STATIC
  src/common/utils.cpp
  src/common/logger.cpp
  src/engine/engine.cpp
  src/db/database.cpp
  src/rpc/locktime_service.cpp
  ${CMAKE_CURRENT_BINARY_DIR}/generated/locktime.pb.cc
)
target_include_directories(locktime_core PUBLIC
  src
  ${CMAKE_CURRENT_BINARY_DIR}/generated
  third_party/sqlite
)
target_link_libraries(locktime_core PUBLIC
  ibridger::sdk::cpp
  ibridger::core
  protobuf::libprotobuf
  sqlite3
  spdlog::spdlog
)
# if(WIN32)
#   target_link_libraries(locktime_core PUBLIC advapi32 user32)
# endif()

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
# if(WIN32)
#   add_executable(blocker WIN32 cmd/blocker/main.cpp ${CMAKE_CURRENT_BINARY_DIR}/generated/locktime.pb.cc)
#   target_include_directories(blocker PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/generated)
#   target_link_libraries(blocker PRIVATE ibridger::sdk::cpp protobuf::libprotobuf user32)
# endif()
