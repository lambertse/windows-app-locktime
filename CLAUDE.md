# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

LockTime is a Windows utility that blocks or time-limits any application on a schedule. It uses Windows Image File Execution Options (IFEO) registry keys to intercept app launches, and a background service for enforcement. A React web dashboard runs at `http://localhost:8089` for rule management.

## Commands

### Backend (Go)
```bash
cd backend

# Build Windows binaries (cross-compiles from any OS)
make build-windows       # outputs backend/dist/locktime-svc.exe, backend/dist/blocker.exe

# Run tests
make test                # engine tests only (platform-neutral)
make test-cover          # generates coverage.html

# Run a specific test
go test ./internal/engine/... -v -run TestName

# Run service locally for development (Linux/Mac)
go run ./cmd/locktime-svc --run   # API at http://localhost:8089

make tidy
make clean
make installer           # builds NSIS installer
```

### Frontend (Node.js/React)
```bash
cd frontend

npm install
npm run dev              # dev server at http://localhost:5173, proxies /api to :8089
npm run build            # outputs frontend/dist/
npm run lint
```

### Windows Service Management (PowerShell, Admin)
```powershell
.\locktime-svc.exe --install
.\locktime-svc.exe --uninstall
.\locktime-svc.exe --run     # foreground/debug mode
```

## Architecture

```
backend/
  cmd/
    locktime-svc/    # Windows Service binary (entry point)
    blocker/         # IFEO interceptor stub — runs instead of blocked app
  internal/
    api/             # Gin HTTP handlers (REST API)
    db/              # SQLite schema + queries (auto-created on first run)
    engine/          # Rule evaluation: time windows, daily limits
    watcher/         # Polled process monitor (fallback enforcement, 1s interval)
    service/         # Windows Service install/lifecycle

frontend/
  src/
    api/             # Typed API client (client.ts)
    pages/           # Dashboard, Rules, AddRule, EditRule, Stats
    components/      # UI components (Radix UI + Tailwind)
    types/           # TypeScript API types
```

### How Enforcement Works

1. `locktime-svc.exe` runs as a Windows Service (SYSTEM privileges).
2. For each enabled rule, it writes `blocker.exe` as the IFEO "debugger" for the target `.exe` in `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\`.
3. When a user launches a blocked app, Windows executes `blocker.exe` instead, which queries the service API to decide whether to allow or deny.
4. The process watcher polls running processes every second as a fallback (catches apps already running before rules were applied).

### Key Design Details

- API binds to `127.0.0.1:8089` only (no remote access).
- Windows-specific code is guarded with `//go:build windows` build tags; Linux/Mac stubs exist for development.
- SQLite uses WAL mode and foreign keys. Database is auto-created at `C:\ProgramData\locktime\locktime.db` on Windows.
- No migration system — schema uses `CREATE TABLE IF NOT EXISTS` and is idempotent.
- Clock skew protection: if system clock is >5 minutes off NTP, the most restrictive state is enforced.
- On service startup, orphaned usage sessions from prior crashes are closed automatically.

### Tech Stack

- **Backend:** Go 1.22+, Gin, SQLite (modernc.org/sqlite), golang.org/x/sys
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS 4, TanStack Query 5, React Router 7, Radix UI, Recharts
- **Installer:** NSIS

### CI/CD

GitHub Actions (`.github/workflows/release.yml`) triggers on `v*.*.*` tags: builds frontend, cross-compiles Go binaries for Windows, builds NSIS installer, publishes a GitHub Release.
