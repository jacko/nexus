import { ElectronAPI } from '@electron-toolkit/preload'

interface ChatConnectConfig {
  nickname: string
}

interface ChatState {
  connected: boolean
  userId: string | null
  nickname: string | null
  rooms: string[]
  peerCount: number
}

interface AppSettings {
  leftSidebarWidth: number
  rightSidebarWidth: number
  showMemberList: boolean
  lastSeenVersion: string
  soundEnabled: boolean
  soundVolume: number
  avatarPath: string
  downloadFolder: string
  language: string
}

interface StoredDmMessage {
  id: string
  sender: string
  nickname: string
  text: string
  timestamp: number
  failed?: boolean
}

interface StoredDmConversation {
  messages: StoredDmMessage[]
  unread: number
  nickname: string
}

interface SharedFolder {
  path: string
  name: string
  totalSize: number
  fileCount: number
}

interface FileTreeNode {
  name: string
  size: number
  contentHash?: string
  children?: FileTreeNode[]
}

interface FileListData {
  userId: string
  nickname: string
  folders: {
    name: string
    totalSize: number
    fileCount: number
    tree: FileTreeNode
  }[]
}

interface TransferRecord {
  contentHash: string
  fileName: string
  status: 'complete' | 'failed' | 'interrupted' | 'paused'
  bytesTotal: number
  bytesDownloaded?: number
  savePath?: string
  error?: string
  completedAt: number
}

interface ChatAPI {
  connect(config: ChatConnectConfig): Promise<string>
  disconnect(): Promise<void>
  joinRoom(room: string): Promise<void>
  leaveRoom(room: string): Promise<void>
  sendMessage(room: string, text: string): Promise<void>
  sendDm(userId: string, text: string): Promise<void>
  setNickname(nickname: string): Promise<void>
  getState(): Promise<ChatState>
  getStoredNickname(): Promise<string | null>
  loadDmConversation(peerId: string): Promise<StoredDmConversation | null>
  loadAllDmConversations(): Promise<Record<string, StoredDmConversation>>
  saveDmConversation(peerId: string, conversation: StoredDmConversation): Promise<void>
  loadSettings(): Promise<AppSettings>
  saveSettings(partial: Partial<AppSettings>): Promise<void>
  addSharedFolder(): Promise<SharedFolder[] | null>
  removeSharedFolder(folderPath: string): Promise<SharedFolder[]>
  getSharedFolders(): Promise<SharedFolder[]>
  rescanShares(): Promise<SharedFolder[]>
  browseUser(userId: string): Promise<void>
  searchFiles(query: string): Promise<string>

  // P2P / file transfers
  startP2P(config: unknown): Promise<string>
  stopP2P(): Promise<void>
  addPeer(multiaddr: string): Promise<void>
  getNatStatus(): Promise<string>
  getExternalIp(): Promise<string>
  getBootstrapStatus(): Promise<boolean>
  getRelayStatus(): Promise<{ status: string; relayAddr: string }>
  indexFolder(path: string): Promise<void>
  startDownload(hash: string, fileName: string, relativePath?: string): Promise<void>
  pauseDownload(hash: string): Promise<void>
  resumeDownload(hash: string): Promise<void>
  cancelDownload(hash: string): Promise<void>
  getActiveDownloads(): Promise<unknown>
  openDownloadsFolder(): Promise<void>
  showInFolder(filePath: string): Promise<void>
  getTransferHistory(): Promise<TransferRecord[]>
  clearTransferHistory(): Promise<void>
  removeTransferHistory(contentHash: string): Promise<void>
  sendMultiaddr(multiaddr: string): Promise<void>

  // Identity management
  hasIdentity(): Promise<boolean>
  generateMnemonic(): Promise<string>
  createFromMnemonic(mnemonic: string, nickname: string): Promise<string>
  validateMnemonic(mnemonic: string): Promise<boolean>

  // Downloads
  pickDownloadFolder(): Promise<string | null>

  // Avatar
  pickAvatar(): Promise<string | null>
  removeAvatar(): Promise<void>

  // App info
  getAppVersion(): Promise<string>

  // Auto-updater
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  installUpdate(): Promise<void>
  onUpdaterEvent(callback: (event: string, data: unknown) => void): () => void

  onP2PEvent(callback: (eventJson: string) => void): () => void

  onEvent(callback: (event: string, data: unknown) => void): () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ChatAPI
  }
}
