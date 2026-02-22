// Chat event data types (matches hub server Socket.IO events)

export interface StatusData {
  userId?: string
  nickname?: string
  peerCount?: number
  connected?: boolean
  reason?: string
  reconnected?: boolean
}

export interface MessageData {
  room: string
  sender: string
  nickname: string
  text: string
  timestamp: number
}

export interface DmData {
  sender: string
  nickname: string
  text: string
  timestamp: number
}

export interface PeerEventData {
  userId: string
  nickname: string
  room: string
  hasAvatar?: boolean
}

export interface RoomHistoryData {
  room: string
  messages: Array<{
    sender: string
    nickname: string
    text: string
    timestamp: number
    hasAvatar?: boolean
  }>
}

export interface MemberListData {
  room: string
  members: Array<{
    userId: string
    nickname: string
    hasAvatar?: boolean
  }>
}

export interface AvatarUpdatedData {
  userId: string
  hasAvatar: boolean
}

export interface NicknameChangedData {
  userId: string
  oldNickname: string
  newNickname: string
}

export interface ErrorData {
  message: string
}

// File sharing types

export interface SharedFolder {
  path: string
  name: string
  totalSize: number
  fileCount: number
}

export interface FileTreeNode {
  name: string
  size: number
  contentHash?: string
  children?: FileTreeNode[]
}

export interface FileListData {
  userId: string
  nickname: string
  folders: {
    name: string
    totalSize: number
    fileCount: number
    tree: FileTreeNode
  }[]
}

// Search types

export interface FileSearchResult {
  userId: string
  nickname: string
  fileName: string
  filePath: string
  size: number
  contentHash?: string
  folderName: string
  isFolder?: boolean
}

// Transfer types

export interface TransferInfo {
  contentHash: string
  fileName: string
  status: 'finding_providers' | 'requesting_metadata' | 'downloading' | 'paused' | 'complete' | 'failed' | 'interrupted'
  chunksReceived: number
  chunksTotal: number
  bytesDownloaded: number
  bytesTotal: number
  speedBps: number
  providers: number
  error?: string
  savePath?: string
  fileExists?: boolean
  startedAt?: number
  activeDurationMs?: number
}

// Upload types (provider side)

export interface UploadInfo {
  contentHash: string
  fileName: string
  peerId: string
  nickname: string
  chunksServed: number
  chunksTotal: number
  bytesSent: number
  bytesTotal: number
  speedBps: number
}

// Application state types

export interface ChatMessage {
  id: string
  sender: string
  nickname: string
  text: string
  timestamp: number
  system?: boolean
  failed?: boolean
}

export interface DMConversation {
  peerId: string
  nickname: string
  messages: ChatMessage[]
  unread: number
}

export interface RoomState {
  name: string
  messages: ChatMessage[]
  members: Map<string, string> // userId -> nickname
  unread: number
}

export interface IndexingProgress {
  folder: string
  filesScanned: number
  filesTotal: number
  currentFile: string
}

export interface P2PState {
  loading: boolean
  connected: boolean
  myPeerId: string | null
  nickname: string
  peerCount: number
  rooms: Map<string, RoomState>
  activeRoom: string | null
  activeDm: string | null
  dms: Map<string, DMConversation>
  errors: string[]
  sharedFolders: SharedFolder[]
  browseTarget: { userId: string; nickname: string } | null
  browseData: FileListData | null
  browseLoading: boolean
  searchResults: FileSearchResult[]
  searchLoading: boolean
  searchId: string | null
  transfers: Map<string, TransferInfo>
  uploads: Map<string, UploadInfo>
  indexingProgress: IndexingProgress | null
  usersWithAvatar: Set<string>
  natStatus: 'public' | 'private' | 'unknown'
  externalIp: string | null
  bootstrapConnected: boolean
  relayStatus: 'none' | 'reserving' | 'reserved' | 'failed'
  relayAddr: string | null
  blockedUsers: Set<string>
}

// Actions

export type P2PAction =
  | { type: 'SET_CONNECTED'; peerId: string; nickname: string }
  | { type: 'SET_DISCONNECTED' }
  | { type: 'STATUS_UPDATE'; connected: boolean; peerCount: number }
  | { type: 'ROOM_JOINED'; room: string }
  | { type: 'ROOM_LEFT'; room: string }
  | { type: 'SET_ACTIVE_ROOM'; room: string }
  | { type: 'MESSAGE_RECEIVED'; room: string; message: ChatMessage }
  | { type: 'ROOM_HISTORY'; room: string; messages: ChatMessage[]; avatarUsers?: string[] }
  | { type: 'MEMBER_LIST'; room: string; members: Array<{ userId: string; nickname: string; hasAvatar?: boolean }> }
  | { type: 'DM_RECEIVED'; peerId: string; nickname: string; message: ChatMessage }
  | { type: 'PEER_JOINED'; room: string; peerId: string; nickname: string; hasAvatar?: boolean }
  | { type: 'PEER_LEFT'; room: string; peerId: string; nickname: string }
  | { type: 'NICKNAME_CHANGED'; userId: string; oldNickname: string; newNickname: string }
  | { type: 'ERROR'; message: string }
  | { type: 'CLEAR_UNREAD'; room: string }
  | { type: 'SET_NICKNAME'; nickname: string }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ACTIVE_DM'; peerId: string }
  | { type: 'CLEAR_DM_UNREAD'; peerId: string }
  | { type: 'OPEN_DM'; peerId: string; nickname: string }
  | { type: 'MARK_DM_FAILED'; peerId: string; messageId: string }
  | { type: 'LOAD_DM_HISTORY'; peerId: string; nickname: string; messages: ChatMessage[]; unread: number }
  | { type: 'SET_SHARED_FOLDERS'; folders: SharedFolder[] }
  | { type: 'BROWSE_LOADING'; userId: string; nickname: string }
  | { type: 'BROWSE_DATA'; data: FileListData }
  | { type: 'BROWSE_CLEAR' }
  | { type: 'SEARCH_START'; searchId: string }
  | { type: 'SEARCH_RESULTS'; searchId: string; results: FileSearchResult[] }
  | { type: 'SEARCH_DONE' }
  | { type: 'SEARCH_CLEAR' }
  | { type: 'TRANSFER_PROGRESS'; transfer: TransferInfo }
  | { type: 'TRANSFER_COMPLETE'; contentHash: string; savePath: string; size: number }
  | { type: 'TRANSFER_ERROR'; contentHash: string; message: string }
  | { type: 'TRANSFER_REMOVED'; contentHash: string }
  | { type: 'LOAD_TRANSFER_HISTORY'; records: Array<{ contentHash: string; fileName: string; status: 'complete' | 'failed' | 'interrupted' | 'paused'; bytesTotal: number; bytesDownloaded?: number; savePath?: string; error?: string; completedAt: number; fileExists?: boolean; startedAt?: number; activeDurationMs?: number }> }
  | { type: 'CLEAR_TRANSFER_HISTORY' }
  | { type: 'UPLOAD_PROGRESS'; upload: UploadInfo }
  | { type: 'UPLOAD_COMPLETE'; contentHash: string; peerId: string }
  | { type: 'INDEX_PROGRESS'; progress: IndexingProgress }
  | { type: 'INDEX_COMPLETE'; folder: string; fileCount: number }
  | { type: 'AVATAR_UPDATED'; userId: string; hasAvatar: boolean }
  | { type: 'NAT_STATUS'; status: 'public' | 'private' | 'unknown' }
  | { type: 'EXTERNAL_IP'; ip: string }
  | { type: 'BOOTSTRAP_STATUS'; connected: boolean }
  | { type: 'RELAY_STATUS'; status: 'none' | 'reserving' | 'reserved' | 'failed'; relayAddr: string | null }
  | { type: 'SET_BLOCKED_USERS'; userIds: string[] }
  | { type: 'BLOCK_USER'; userId: string }
  | { type: 'UNBLOCK_USER'; userId: string }
