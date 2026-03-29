# LockTime

> Stop yourself from opening League of Legends at 2 AM. Or any app, really.

A lightweight utility that blocks or time-limits any application on a schedule — powered by a Go background service and a web dashboard. Runs on **Windows** and **macOS**.

![Dashboard Screenshot](docs/images/dashboard.png)

---

## Features

- **Time window locking** — block an app outside allowed hours (e.g. no games after 11 PM)
- **Daily time limits** — allow up to N minutes per day, then locked for the rest of the day
- **Combined rules** — time window + daily limit on the same app
- **Real-time dashboard** — see what's locked, time used today, and when it unlocks
- **Usage stats** — daily and weekly charts
- **Starts on boot** — runs as a Windows Service or macOS LaunchDaemon
- **Anti-bypass (Windows)** — uses IFEO registry keys so renaming the exe doesn't help

---

## Architecture

```
app-locktime/
├── backend/
│   ├── cmd/
│   │   ├── locktime-svc/      # Service binary (Windows + macOS)
│   │   └── blocker/           # IFEO interceptor stub (Windows only)
│   └── internal/
│       ├── api/               # REST API (Gin, port 8089)
│       ├── db/                # SQLite schema + queries
│       ├── engine/            # Rule evaluation + time window logic
│       ├── watcher/           # Process monitor (cross-platform)
│       └── service/           # Service lifecycle (platform-specific)
└── frontend/                  # React/Vite dashboard (port 8090)
    └── src/
        ├── pages/             # Dashboard, Rules, Stats
        ├── components/        # UI components
        ├── api/               # Typed API client
        └── lib/               # Utilities
```

### Ports

| Port | Purpose |
|------|---------|
| `127.0.0.1:8089` | REST API (internal only) |
| `127.0.0.1:8090` | Web dashboard |

### How enforcement works

**Windows:**
1. `locktime-svc.exe` runs as a Windows Service (SYSTEM privileges)
2. For each enabled rule it writes `blocker.exe` as the IFEO "debugger" for the target `.exe`
3. When the user launches a blocked app, Windows runs `blocker.exe` instead
4. `blocker.exe` queries the API — shows a block dialog or launches the real app
5. The process watcher polls every second as a fallback for already-running processes
6. The frontend is served by **nginx** on port 8090, which also proxies `/api/` to port 8089

**macOS:**
1. `locktime-svc` runs as a LaunchDaemon (root)
2. No pre-launch interception (no IFEO equivalent on macOS)
3. The process watcher polls every second and sends `SIGTERM` to blocked processes
4. The frontend is served by a built-in Go HTTP server on port 8090

---

## Getting Started

### Prerequisites

| | Windows | macOS |
|---|---|---|
| OS | Windows 10/11 64-bit | macOS 12+ (Apple Silicon or Intel) |
| Privileges | Administrator | root (sudo) |
| Build deps | Go 1.22+, Node.js 18+ | Go 1.22+, Node.js 18+ |

### Install from Release

Download the latest release from [Releases](https://github.com/lambertse/app-locktime/releases).

**Windows** — run the installer as Administrator:
```
locktime-installer.exe
```
The service installs, starts automatically, and opens `http://localhost:8090`.

**macOS** — install the daemon manually after building (see Build from Source):
```bash
sudo ./locktime-svc --install
```

### Build from Source

```bash
git clone https://github.com/lambertse/app-locktime.git
cd app-locktime
```

**Frontend:**
```bash
cd frontend
npm install
npm run build        # output: frontend/dist/
```

**Backend — Windows:**
```bash
cd backend
make build-windows   # output: dist/locktime-svc.exe, dist/blocker.exe
```

**Backend — macOS:**
```bash
cd backend
make build-macos     # output: dist/locktime-svc
```

---

## Usage

### Open the dashboard

Once the service is running:
```
http://localhost:8090
```

### Add a rule

1. Click **Add Rule** in the sidebar
2. Pick the app — from the running process list or by browsing to the executable
3. Set the limit:
   - **Time window** — which hours and days the app is allowed
   - **Daily limit** — max minutes per day
   - **Both** — combine them
4. Save — the rule is active immediately

### Manage the service

**Windows (PowerShell, Administrator):**
```powershell
.\locktime-svc.exe --install     # install + start
.\locktime-svc.exe --uninstall   # stop + remove
.\locktime-svc.exe --run         # foreground / debug mode
```

**macOS (Terminal, sudo):**
```bash
sudo ./locktime-svc --install    # write LaunchDaemon plist + load
sudo ./locktime-svc --uninstall  # unload + remove plist
./locktime-svc --run             # foreground / debug mode
```

---

## Development

### Run the backend locally

```bash
cd backend
go run ./cmd/locktime-svc --run
# API at http://127.0.0.1:8089
```

On macOS this runs the full service (process watcher + SPA server). Windows-specific features (IFEO, native file picker) are stubbed out on non-Windows platforms via build tags.

### Run the frontend dev server

```bash
cd frontend
npm run dev
# Dev server at http://localhost:5173
# /api/* proxied to http://127.0.0.1:8089
```

### Tests

```bash
cd backend
make test            # engine tests (platform-neutral)
make test-cover      # with HTML coverage report
```

---

## Data storage

| Platform | Database path |
|----------|--------------|
| Windows  | `C:\ProgramData\locktime\locktime.db` |
| macOS    | `/Library/Application Support/locktime/locktime.db` |

The database is managed entirely through the dashboard — no manual editing needed.

---

## Security notes

- The API only binds to `127.0.0.1` — not accessible from other machines
- **Windows:** service runs as `SYSTEM` (required for IFEO registry writes and cross-user process termination)
- **macOS:** daemon runs as `root` (required for terminating processes owned by any user)
- NTP skew protection: if the system clock is more than 5 minutes off, the most restrictive state is enforced
- **Windows IFEO path:** `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\<exe>`

---

## Roadmap

- [x] Time window locking
- [x] Daily time limits
- [x] Web dashboard
- [x] Usage stats
- [x] Windows installer (NSIS)
- [x] macOS support
- [ ] PIN override — unlock temporarily with a password
- [ ] Notification before lock kicks in
- [ ] System tray icon
- [ ] Multiple profiles (work / weekend mode)

---

## Contributing

PRs welcome. Open an issue first for anything significant.

---

## License

MIT — see [LICENSE](LICENSE)
