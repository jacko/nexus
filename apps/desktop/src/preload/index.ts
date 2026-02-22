import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const chatAPI = {
  connect: (config: { nickname: string }): Promise<string> =>
    ipcRenderer.invoke('chat:connect', config),

  disconnect: (): Promise<void> => ipcRenderer.invoke('chat:disconnect'),

  joinRoom: (room: string): Promise<void> => ipcRenderer.invoke('chat:joinRoom', room),

  leaveRoom: (room: string): Promise<void> => ipcRenderer.invoke('chat:leaveRoom', room),

  sendMessage: (room: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chat:sendMessage', room, text),

  sendDm: (userId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chat:sendDm', userId, text),

  setNickname: (nickname: string): Promise<void> =>
    ipcRenderer.invoke('chat:setNickname', nickname),

  getState: (): Promise<{
    connected: boolean
    userId: string | null
    nickname: string | null
    rooms: string[]
    peerCount: number
  }> => ipcRenderer.invoke('chat:getState'),

  getStoredNickname: (): Promise<string | null> => ipcRenderer.invoke('chat:getStoredNickname'),

  loadSettings: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('settings:load'),

  saveSettings: (partial: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('settings:save', partial),

  pickDownloadFolder: (): Promise<string | null> => ipcRenderer.invoke('pickDownloadFolder'),

  loadDmConversation: (peerId: string): Promise<unknown> =>
    ipcRenderer.invoke('chat:loadDmConversation', peerId),

  loadAllDmConversations: (): Promise<unknown> =>
    ipcRenderer.invoke('chat:loadAllDmConversations'),

  saveDmConversation: (peerId: string, conversation: unknown): Promise<void> =>
    ipcRenderer.invoke('chat:saveDmConversation', peerId, conversation),

  addSharedFolder: (): Promise<unknown> => ipcRenderer.invoke('shares:addFolder'),

  removeSharedFolder: (folderPath: string): Promise<unknown> =>
    ipcRenderer.invoke('shares:removeFolder', folderPath),

  getSharedFolders: (): Promise<unknown> => ipcRenderer.invoke('shares:getShared'),

  rescanShares: (): Promise<unknown> => ipcRenderer.invoke('shares:rescan'),

  browseUser: (userId: string): Promise<void> => ipcRenderer.invoke('shares:browseUser', userId),

  searchFiles: (query: string): Promise<string> => ipcRenderer.invoke('shares:searchFiles', query),

  // P2P / file transfers
  startP2P: (config: unknown): Promise<string> => ipcRenderer.invoke('p2p:start', config),

  stopP2P: (): Promise<void> => ipcRenderer.invoke('p2p:stop'),

  addPeer: (multiaddr: string): Promise<void> => ipcRenderer.invoke('p2p:addPeer', multiaddr),

  getNatStatus: (): Promise<string> => ipcRenderer.invoke('p2p:getNatStatus'),

  getExternalIp: (): Promise<string> => ipcRenderer.invoke('p2p:getExternalIp'),

  getBootstrapStatus: (): Promise<boolean> => ipcRenderer.invoke('p2p:getBootstrapStatus'),

  getRelayStatus: (): Promise<{ status: string; relayAddr: string }> =>
    ipcRenderer.invoke('p2p:getRelayStatus'),

  indexFolder: (path: string): Promise<void> => ipcRenderer.invoke('p2p:indexFolder', path),

  startDownload: (hash: string, fileName: string, relativePath?: string): Promise<void> =>
    ipcRenderer.invoke('transfers:download', hash, fileName, relativePath),

  pauseDownload: (hash: string): Promise<void> => ipcRenderer.invoke('transfers:pause', hash),

  resumeDownload: (hash: string): Promise<void> => ipcRenderer.invoke('transfers:resume', hash),

  cancelDownload: (hash: string): Promise<void> => ipcRenderer.invoke('transfers:cancel', hash),

  getActiveDownloads: (): Promise<unknown> => ipcRenderer.invoke('transfers:getActive'),

  openDownloadsFolder: (): Promise<void> => ipcRenderer.invoke('transfers:openFolder'),

  showInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('transfers:showInFolder', filePath),

  getTransferHistory: (): Promise<unknown[]> => ipcRenderer.invoke('transfers:getHistory'),

  clearTransferHistory: (): Promise<void> => ipcRenderer.invoke('transfers:clearHistory'),

  removeTransferHistory: (contentHash: string): Promise<void> =>
    ipcRenderer.invoke('transfers:removeHistory', contentHash),

  sendMultiaddr: (multiaddr: string): Promise<void> =>
    ipcRenderer.invoke('chat:sendMultiaddr', multiaddr),

  onP2PEvent: (callback: (eventJson: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, eventJson: string): void => {
      callback(eventJson)
    }
    ipcRenderer.on('p2p:event', handler)
    return () => {
      ipcRenderer.removeListener('p2p:event', handler)
    }
  },

  // Identity management
  hasIdentity: (): Promise<boolean> => ipcRenderer.invoke('identity:hasIdentity'),

  generateMnemonic: (): Promise<string> => ipcRenderer.invoke('identity:generateMnemonic'),

  createFromMnemonic: (mnemonic: string, nickname: string): Promise<string> =>
    ipcRenderer.invoke('identity:createFromMnemonic', mnemonic, nickname),

  validateMnemonic: (mnemonic: string): Promise<boolean> =>
    ipcRenderer.invoke('identity:validateMnemonic', mnemonic),

  // Avatar
  pickAvatar: (): Promise<string | null> => ipcRenderer.invoke('avatar:pick'),

  removeAvatar: (): Promise<void> => ipcRenderer.invoke('avatar:remove'),

  // App info
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  // Auto-updater
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),

  downloadUpdate: (): Promise<unknown> => ipcRenderer.invoke('updater:download'),

  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),

  onUpdaterEvent: (callback: (event: string, data: unknown) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      eventName: string,
      data: unknown
    ): void => {
      callback(eventName, data)
    }
    ipcRenderer.on('updater:event', handler)
    return () => {
      ipcRenderer.removeListener('updater:event', handler)
    }
  },

  onEvent: (callback: (event: string, data: unknown) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      eventName: string,
      data: unknown
    ): void => {
      callback(eventName, data)
    }
    ipcRenderer.on('chat:event', handler)
    return () => {
      ipcRenderer.removeListener('chat:event', handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', chatAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = chatAPI
}
