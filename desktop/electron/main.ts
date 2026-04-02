import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, dialog } from 'electron'

Menu.setApplicationMenu(null)

import path from 'path'
import { execFile } from 'child_process'
import { initLogger, log } from './logger'
import { LockTimeRPCClient, RPC_ENDPOINT } from './locktime-rpc'
import type {
  CreateRuleRequest,
  UpdateRuleRequest,
  PatchRuleRequest,
  GrantOverrideRequest,
  GetBlockAttemptsRequest,
} from './locktime-rpc'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// ─── Popup mode ───────────────────────────────────────────────────────────────

interface PopupArgs {
  isPopup: true
  appName: string
  ruleName: string
  reason: string
  nextUnlock: string
}

function parsePopupArgs(argv: string[]): PopupArgs | null {
  if (!argv.includes('--popup')) return null
  const get = (flag: string) => {
    const prefix = `${flag}=`
    const hit = argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : ''
  }
  return {
    isPopup: true,
    appName: get('--app-name'),
    ruleName: get('--rule-name'),
    reason: get('--reason'),
    nextUnlock: get('--next-unlock'),
  }
}

function createPopupWindow(info: PopupArgs): void {
  const popup = new BrowserWindow({
    width: 440,
    height: 140,
    resizable: false,
    alwaysOnTop: true,
    frame: false,
    skipTaskbar: true,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  const params = new URLSearchParams({
    app: info.appName,
    rule: info.ruleName,
    reason: info.reason,
    unlock: info.nextUnlock,
  })
  const hash = `/popup?${params.toString()}`

  if (isDev) {
    popup.loadURL(`${process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:8090'}#${hash}`)
  } else {
    popup.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash })
  }

  log.info(`Popup window created for app="${info.appName}" rule="${info.ruleName}"`)
}

const popupArgs = parsePopupArgs(process.argv)

// ─── RPC Client ──────────────────────────────────────────────────────────────
const rpc = new LockTimeRPCClient(RPC_ENDPOINT)
// ─── Service Management ──────────────────────────────────────────────────────

const SERVICE_NAME_WIN = 'AppLockerSvc'
const SERVICE_NAME_MAC = 'com.lambertse.locktime'

function getServiceExePath(): string {
  if (isDev) return ''
  if (process.platform === 'darwin') {
    return path.join(process.resourcesPath, 'bin', 'locktime-svc')
  }
  return path.join(process.resourcesPath, 'bin', 'locktime-svc.exe')
}

function isServiceRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('sc', ['query', SERVICE_NAME_WIN], (err, stdout) => {
        resolve(!err && stdout.includes('RUNNING'))
      })
    } else if (process.platform === 'darwin') {
      // `launchctl list <label>` exits 0 if the service is loaded/running
      execFile('launchctl', ['list', SERVICE_NAME_MAC], (err) => {
        resolve(!err)
      })
    } else {
      resolve(false)
    }
  })
}

async function ensureServiceRunning(): Promise<void> {
  log.info('ensuring backend service is running...')
  // In dev mode the developer runs the backend manually; just attempt a lazy
  // connect so the first RPC call doesn't block on reconnection.
  if (isDev) {
    try {
      await rpc.connect()
    } catch {
      /* backend may not be up yet */
    }
    return
  }

  if (process.platform === 'win32') {
    const running = await isServiceRunning()
    if (!running) {
      const svcPath = getServiceExePath()
      if (svcPath) {
        await new Promise<void>((resolve) => {
          execFile('sc', ['start', SERVICE_NAME_WIN], () => resolve())
        })
      }
    }
  } else if (process.platform === 'darwin') {
    const running = await isServiceRunning()
    if (!running) {
      // The launchd plist must already be installed by the app installer.
      // Just kick the service; launchd will keep it alive thereafter.
      await new Promise<void>((resolve) => {
        execFile('launchctl', ['start', SERVICE_NAME_MAC], () => resolve())
      })
    }
  }

  // Wait for the RPC server to become reachable (all platforms)
  for (let i = 0; i < 20; i++) {
    try {
      await rpc.connect()
      log.info(`RPC server reachable at ${RPC_ENDPOINT}`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  log.warn('RPC server did not respond within 10 s — continuing anyway')
}

// ─── Single Instance ─────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock(popupArgs ?? {})
if (!gotLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', (_event, _argv, _workingDir, additionalData) => {
  const data = additionalData as Record<string, unknown>
  if (data?.isPopup) {
    createPopupWindow(data as unknown as PopupArgs)
  } else {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  }
})

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray(): void {
  const iconPath = isDev
    ? path.join(__dirname, '..', 'public', 'icons', 'icon.ico')
    : path.join(process.resourcesPath, 'icons', 'icon.ico')

  let trayIcon = nativeImage.createEmpty()
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
  } catch {
    // icon not found in dev — tray uses empty icon
  }

  tray = new Tray(trayIcon)
  tray.setToolTip('AppLocker')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { label: 'Hide', click: () => mainWindow?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show()
    }
  })
}

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'AppLocker',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // Apply a strict CSP in production only.
  // In dev, Vite injects inline scripts (React Fast Refresh preamble) that
  // would be blocked by script-src 'self', causing a blank renderer.
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
              "script-src 'self'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "connect-src 'self'; " +
              "img-src 'self' data:; " +
              "font-src 'self' data:;",
          ],
        },
      })
    })
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (isDev) {
    // vite-plugin-electron sets VITE_DEV_SERVER_URL to the actual Vite server
    // URL (including port), so we don't need to hardcode it.
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:8090')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

// ─── IPC — Window Controls ───────────────────────────────────────────────────

ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:hide', () => mainWindow?.hide())
ipcMain.on('window:quit', () => app.quit())

ipcMain.on('popup:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})

// ─── IPC — RPC Bridge ────────────────────────────────────────────────────────
// Each handler calls the C++ backend via iBridger and returns the result to the
// renderer. Errors are returned as { __error: message } so the renderer can
// throw them back to the caller.

function rpcHandler<T>(fn: () => Promise<T>) {
  return async (): Promise<T | { __error: string }> => {
    try {
      // Fail fast when disconnected — IBridgerClient reconnects automatically
      // in the background (maxAttempts: Infinity, exponential backoff).
      // Awaiting connect() here would block all overlapping interval calls.
      if (!rpc.isConnected) {
        return { __error: 'Service unavailable — reconnecting…' }
      }
      return await fn()
    } catch (err) {
      log.error(`RPC error: ${err instanceof Error ? err.message : String(err)}`)
      return { __error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// Status
ipcMain.handle(
  'api:getStatus',
  rpcHandler(() => rpc.getStatus()),
)

// Rules
ipcMain.handle(
  'api:listRules',
  rpcHandler(() => rpc.listRules()),
)
ipcMain.handle('api:getRule', (_e, id: string) => rpcHandler(() => rpc.getRule(id))())
ipcMain.handle('api:createRule', (_e, req: CreateRuleRequest) =>
  rpcHandler(() => rpc.createRule(req))(),
)
ipcMain.handle('api:updateRule', (_e, req: UpdateRuleRequest) =>
  rpcHandler(() => rpc.updateRule(req))(),
)
ipcMain.handle('api:patchRule', (_e, req: PatchRuleRequest) =>
  rpcHandler(() => rpc.patchRule(req))(),
)
ipcMain.handle('api:deleteRule', (_e, id: string) => rpcHandler(() => rpc.deleteRule(id))())

// Overrides
ipcMain.handle('api:grantOverride', (_e, req: GrantOverrideRequest) =>
  rpcHandler(() => rpc.grantOverride(req))(),
)
ipcMain.handle('api:revokeOverride', (_e, ruleId: string) =>
  rpcHandler(() => rpc.revokeOverride(ruleId))(),
)

// Usage
ipcMain.handle(
  'api:getUsageToday',
  rpcHandler(() => rpc.getUsageToday()),
)
ipcMain.handle(
  'api:getUsageWeek',
  rpcHandler(() => rpc.getUsageWeek()),
)
ipcMain.handle('api:getBlockAttempts', (_e, req: GetBlockAttemptsRequest = {}) =>
  rpcHandler(() => rpc.getBlockAttempts(req))(),
)

// System
ipcMain.handle(
  'api:getProcesses',
  rpcHandler(() => rpc.getProcesses()),
)

// Browse file — handled entirely by Electron (no C++ needed)
ipcMain.handle('api:browseFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select Executable',
    filters: [
      { name: 'Executables', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  return {
    path: result.canceled ? null : (result.filePaths[0] ?? null),
    cancelled: result.canceled,
  }
})

// Config
ipcMain.handle(
  'api:getConfig',
  rpcHandler(() => rpc.getConfig()),
)
ipcMain.handle('api:updateConfig', (_e, config: Record<string, string>) =>
  rpcHandler(() => rpc.updateConfig(config))(),
)

// ─── App Lifecycle ────────────────────────────────────────────────────────────

// ─── IPC — Renderer logging bridge ───────────────────────────────────────────
// The renderer cannot use @vscode/spdlog directly (native addon, main-only).
// It sends log records here via fire-and-forget ipcRenderer.send().

ipcMain.on('log:write', (_e, level: string, message: string) => {
  const prefixed = `[renderer] ${message}`
  switch (level) {
    case 'error':
      log.error(prefixed)
      break
    case 'warn':
      log.warn(prefixed)
      break
    case 'debug':
      log.debug(prefixed)
      break
    default:
      log.info(prefixed)
      break
  }
})

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setName('AppLocker')
  await initLogger()

  if (popupArgs) {
    // Popup-only mode: no service connection, no tray, no main window.
    // The process quits automatically when the popup window is closed
    // (handled by window-all-closed below).
    log.info(`AppLocker starting in popup mode — app="${popupArgs.appName}"`)
    createPopupWindow(popupArgs)
    return
  }

  app.setLoginItemSettings({ openAtLogin: false, name: 'AppLocker' })
  log.info(`AppLocker starting — platform=${process.platform} dev=${isDev}`)
  log.info(`RPC endpoint: ${RPC_ENDPOINT}`)

  await ensureServiceRunning()

  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
  log.info('AppLocker shutting down')
  log.flush()
  rpc.disconnect()
})

app.on('window-all-closed', () => {
  if (popupArgs) {
    // Popup-only mode: quit when the popup is dismissed
    app.quit()
    return
  }
  // Normal mode: stay in tray — do not quit
})
