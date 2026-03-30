import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  onTrayShow: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('tray:show', listener)
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('tray:show', listener)
    }
  },

  minimize: () => {
    ipcRenderer.send('window:minimize')
  },

  hide: () => {
    ipcRenderer.send('window:hide')
  },

  quit: () => {
    ipcRenderer.send('window:quit')
  },
})
