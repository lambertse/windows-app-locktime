import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  session,
} from 'electron'

// Remove default application menu (File, Edit, View, Window, Help)
Menu.setApplicationMenu(null)
import path from 'path'
import { execFile, spawn } from 'child_process'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// ─── Service Management ─────────────────────────────────────────────────────

const SERVICE_NAME = 'AppLockerSvc'
const API_URL = 'http://127.0.0.1:8089/api/v1/status'

function getServiceExePath(): string {
  if (isDev) return '' // service managed manually in dev
  return path.join(process.resourcesPath, 'bin', 'locktime-svc.exe')
}

function isServiceRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(false)
      return
    }
    execFile('sc', ['query', SERVICE_NAME], (err, stdout) => {
      resolve(!err && stdout.includes('RUNNING'))
    })
  })
}

async function ensureServiceRunning(): Promise<void> {
  if (isDev || process.platform !== 'win32') return

  const running = await isServiceRunning()
  if (running) return

  const svcPath = getServiceExePath()
  if (!svcPath) return

  console.log('[AppLocker] Starting background service...')
  // Try sc start first (service already installed)
  await new Promise<void>((resolve) => {
    execFile('sc', ['start', SERVICE_NAME], () => resolve())
  })

  // Wait up to 5s for API to become reachable
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const res = await fetch(API_URL)
      if (res.ok) {
        console.log('[AppLocker] Service is up')
        return
      }
    } catch {
      // not ready yet
    }
  }
  console.warn('[AppLocker] Service did not respond in time')
}

// Enforce single instance
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

function createTray(): void {
  const iconPath = isDev
    ? path.join(__dirname, '..', 'public', 'icons', 'icon.ico')
    : path.join(process.resourcesPath, 'icons', 'icon.ico')

  let trayIcon = nativeImage.createEmpty()
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
  } catch {
    // icon file may not exist yet — tray will use empty icon
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
    {
      label: 'Hide',
      click: () => {
        mainWindow?.hide()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

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
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // Apply CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "connect-src 'self' http://127.0.0.1:8089; " +
            "img-src 'self' data:; " +
            "font-src 'self' data:;",
        ],
      },
    })
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Minimize to tray on close
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

// IPC handlers
ipcMain.on('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.on('window:hide', () => {
  mainWindow?.hide()
})

ipcMain.on('window:quit', () => {
  app.quit()
})

app.whenReady().then(async () => {
  app.setName('AppLocker')

  app.setLoginItemSettings({
    openAtLogin: false,
    name: 'AppLocker',
  })

  // Ensure the Go backend service is running before showing the window
  await ensureServiceRunning()

  createWindow()
  createTray()

  app.on('activate', () => {
    // macOS: re-create window if dock icon clicked and no windows open
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

// Keep app running when all windows closed (we use tray)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit — stay in tray
  }
})
