import { contextBridge, ipcRenderer } from 'electron'

// ─── Type helpers ─────────────────────────────────────────────────────────────

type RPCResult<T> = T | { __error: string }

function unwrap<T>(result: RPCResult<T>): T {
  if (result && typeof result === 'object' && '__error' in result) {
    throw new Error((result as { __error: string }).__error)
  }
  return result as T
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then(unwrap<T>)
}

// ─── API bridge ───────────────────────────────────────────────────────────────
// Everything exposed here becomes available as window.api.* in the renderer.
// All methods return Promises and throw on error (unwrapped from { __error }).

contextBridge.exposeInMainWorld('api', {
  // Status
  getStatus: () => invoke('api:getStatus'),

  // Rules
  listRules: () => invoke('api:listRules'),
  getRule: (id: string) => invoke('api:getRule', id),
  createRule: (req: unknown) => invoke('api:createRule', req),
  updateRule: (req: unknown) => invoke('api:updateRule', req),
  patchRule: (req: unknown) => invoke('api:patchRule', req),
  deleteRule: (id: string) => invoke('api:deleteRule', id),

  // Overrides
  grantOverride: (req: unknown) => invoke('api:grantOverride', req),
  revokeOverride: (ruleId: string) => invoke('api:revokeOverride', ruleId),

  // Usage
  getUsageToday: () => invoke('api:getUsageToday'),
  getUsageWeek: () => invoke('api:getUsageWeek'),
  getBlockAttempts: (req?: unknown) => invoke('api:getBlockAttempts', req ?? {}),

  // System
  getProcesses: () => invoke('api:getProcesses'),
  browseFile: () => invoke('api:browseFile'),

  // Config
  getConfig: () => invoke('api:getConfig'),
  updateConfig: (cfg: unknown) => invoke('api:updateConfig', cfg),
})

// ─── Window controls ──────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  onTrayShow: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('tray:show', listener)
    return () => ipcRenderer.removeListener('tray:show', listener)
  },

  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('window:quit'),
  closePopup: () => ipcRenderer.send('popup:close'),

  // Fire-and-forget logging bridge — writes to the main-process spdlog file.
  log: (level: string, message: string) => ipcRenderer.send('log:write', level, message),
})
