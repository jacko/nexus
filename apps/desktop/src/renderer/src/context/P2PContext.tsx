import { createContext, useReducer, useEffect, useCallback, useRef, ReactNode } from 'react'
import i18n from '../i18n'
import type {
  P2PState,
  P2PAction,
  ChatMessage,
  RoomState,
  SharedFolder,
  FileListData,
  FileSearchResult,
  TransferInfo,
  StatusData,
  MessageData,
  DmData,
  PeerEventData,
  RoomHistoryData,
  MemberListData,
  NicknameChangedData,
  ErrorData,
  AvatarUpdatedData
} from '../types/p2p'

let nextMsgId = 0
function msgId(): string {
  return `msg-${Date.now()}-${nextMsgId++}`
}

import pipSoundUrl from '../assets/pip.mp3'

let pipAudio: HTMLAudioElement | null = null
let _soundEnabled = true
let _soundVolume = 1.0

export function setSoundEnabled(v: boolean): void { _soundEnabled = v }
export function setSoundVolume(v: number): void { _soundVolume = v }

let _avatarCacheBust = Date.now()
export function getAvatarCacheBust(): number { return _avatarCacheBust }
export function bumpAvatarCacheBust(): void { _avatarCacheBust = Date.now() }

export function playNotificationSound(): void {
  if (!_soundEnabled) return
  try {
    if (!pipAudio) pipAudio = new Audio(pipSoundUrl)
    pipAudio.volume = _soundVolume
    pipAudio.currentTime = 0
    pipAudio.play()
  } catch {
    // Audio not available
  }
}

const initialState: P2PState = {
  loading: true,
  connected: false,
  myPeerId: null,
  nickname: 'Anonymous',
  peerCount: 0,
  rooms: new Map(),
  activeRoom: null,
  activeDm: null,
  dms: new Map(),
  errors: [],
  sharedFolders: [],
  browseTarget: null,
  browseData: null,
  browseLoading: false,
  searchResults: [],
  searchLoading: false,
  searchId: null,
  transfers: new Map(),
  uploads: new Map(),
  indexingProgress: null,
  usersWithAvatar: new Set(),
  natStatus: 'unknown',
  externalIp: null,
  bootstrapConnected: false,
  relayStatus: 'none',
  relayAddr: null,
  blockedUsers: new Set()
}

function ensureRoom(rooms: Map<string, RoomState>, name: string): Map<string, RoomState> {
  const next = new Map(rooms)
  if (!next.has(name)) {
    next.set(name, { name, messages: [], members: new Map(), unread: 0 })
  }
  return next
}

function reducer(state: P2PState, action: P2PAction): P2PState {
  switch (action.type) {
    case 'SET_CONNECTED':
      return { ...state, connected: true, myPeerId: action.peerId, nickname: action.nickname }

    case 'SET_DISCONNECTED':
      return { ...state, connected: false, myPeerId: null, peerCount: 0 }

    case 'STATUS_UPDATE':
      return { ...state, connected: action.connected, peerCount: action.peerCount }

    case 'ROOM_JOINED': {
      const rooms = ensureRoom(state.rooms, action.room)
      return { ...state, rooms, activeRoom: state.activeRoom ?? action.room }
    }

    case 'ROOM_LEFT': {
      const rooms = new Map(state.rooms)
      rooms.delete(action.room)
      const activeRoom =
        state.activeRoom === action.room
          ? (rooms.keys().next().value ?? null)
          : state.activeRoom
      return { ...state, rooms, activeRoom }
    }

    case 'SET_ACTIVE_ROOM':
      return { ...state, activeRoom: action.room }

    case 'MESSAGE_RECEIVED': {
      const rooms = ensureRoom(state.rooms, action.room)
      const room = rooms.get(action.room)!
      const isActive = state.activeRoom === action.room
      rooms.set(action.room, {
        ...room,
        messages: [...room.messages, action.message],
        unread: isActive ? room.unread : room.unread + 1
      })
      return { ...state, rooms: new Map(rooms) }
    }

    case 'ROOM_HISTORY': {
      const rooms = ensureRoom(state.rooms, action.room)
      const room = rooms.get(action.room)!
      rooms.set(action.room, {
        ...room,
        messages: action.messages
      })
      if (action.avatarUsers && action.avatarUsers.length > 0) {
        const avatarSet = new Set(state.usersWithAvatar)
        for (const uid of action.avatarUsers) avatarSet.add(uid)
        return { ...state, rooms: new Map(rooms), usersWithAvatar: avatarSet }
      }
      return { ...state, rooms: new Map(rooms) }
    }

    case 'MEMBER_LIST': {
      const rooms = ensureRoom(state.rooms, action.room)
      const room = rooms.get(action.room)!
      const members = new Map<string, string>()
      const avatarSet = new Set(state.usersWithAvatar)
      for (const m of action.members) {
        members.set(m.userId, m.nickname)
        if (m.hasAvatar) avatarSet.add(m.userId)
      }
      rooms.set(action.room, { ...room, members })
      return { ...state, rooms: new Map(rooms), usersWithAvatar: avatarSet }
    }

    case 'DM_RECEIVED': {
      const dms = new Map(state.dms)
      const existing = dms.get(action.peerId)
      const isOwnMessage = action.message.sender === state.myPeerId
      if (existing) {
        dms.set(action.peerId, {
          ...existing,
          nickname: action.nickname,
          messages: [...existing.messages, action.message],
          unread: isOwnMessage ? existing.unread : existing.unread + 1
        })
      } else {
        dms.set(action.peerId, {
          peerId: action.peerId,
          nickname: action.nickname,
          messages: [action.message],
          unread: isOwnMessage ? 0 : 1
        })
      }
      return { ...state, dms }
    }

    case 'PEER_JOINED': {
      const rooms = ensureRoom(state.rooms, action.room)
      const room = rooms.get(action.room)!
      const members = new Map(room.members)
      members.set(action.peerId, action.nickname)
      const systemMsg: ChatMessage = {
        id: msgId(),
        sender: 'System',
        nickname: 'System',
        text: i18n.t('system.joined', { name: action.nickname }),
        timestamp: Date.now(),
        system: true
      }
      rooms.set(action.room, {
        ...room,
        members,
        messages: [...room.messages, systemMsg]
      })
      const avatarSet = new Set(state.usersWithAvatar)
      if (action.hasAvatar) avatarSet.add(action.peerId)
      return { ...state, rooms: new Map(rooms), usersWithAvatar: avatarSet }
    }

    case 'PEER_LEFT': {
      const rooms = new Map(state.rooms)
      const room = rooms.get(action.room)
      if (!room) return state
      const members = new Map(room.members)
      members.delete(action.peerId)
      const systemMsg: ChatMessage = {
        id: msgId(),
        sender: 'System',
        nickname: 'System',
        text: i18n.t('system.left', { name: action.nickname }),
        timestamp: Date.now(),
        system: true
      }
      rooms.set(action.room, {
        ...room,
        members,
        messages: [...room.messages, systemMsg]
      })
      return { ...state, rooms: new Map(rooms) }
    }

    case 'NICKNAME_CHANGED': {
      const rooms = new Map(state.rooms)
      for (const [roomName, room] of rooms) {
        if (room.members.has(action.userId)) {
          const members = new Map(room.members)
          members.set(action.userId, action.newNickname)
          const systemMsg: ChatMessage = {
            id: msgId(),
            sender: 'System',
            nickname: 'System',
            text: i18n.t('system.nicknameChanged', { oldName: action.oldNickname, newName: action.newNickname }),
            timestamp: Date.now(),
            system: true
          }
          rooms.set(roomName, {
            ...room,
            members,
            messages: [...room.messages, systemMsg]
          })
        }
      }
      return { ...state, rooms }
    }

    case 'ERROR': {
      // Strip Electron IPC wrapper: "Error: Error invoking remote method 'x': ..." → clean message
      const cleaned = action.message.replace(
        /^(Error:\s*)?Error invoking remote method '[^']+':\s*(Error:\s*)?/,
        ''
      )
      return { ...state, errors: [...state.errors.slice(-9), cleaned] }
    }

    case 'CLEAR_UNREAD': {
      const rooms = new Map(state.rooms)
      const room = rooms.get(action.room)
      if (!room) return state
      rooms.set(action.room, { ...room, unread: 0 })
      return { ...state, rooms }
    }

    case 'SET_NICKNAME':
      return { ...state, nickname: action.nickname }

    case 'SET_LOADING':
      return { ...state, loading: action.loading }

    case 'SET_ACTIVE_DM':
      return { ...state, activeDm: action.peerId }

    case 'CLEAR_DM_UNREAD': {
      const dms = new Map(state.dms)
      const dm = dms.get(action.peerId)
      if (!dm) return state
      dms.set(action.peerId, { ...dm, unread: 0 })
      return { ...state, dms }
    }

    case 'OPEN_DM': {
      const dms = new Map(state.dms)
      if (!dms.has(action.peerId)) {
        dms.set(action.peerId, {
          peerId: action.peerId,
          nickname: action.nickname,
          messages: [],
          unread: 0
        })
      }
      return { ...state, dms, activeDm: action.peerId }
    }

    case 'MARK_DM_FAILED': {
      const dms = new Map(state.dms)
      const convo = dms.get(action.peerId)
      if (!convo) return state
      dms.set(action.peerId, {
        ...convo,
        messages: convo.messages.map((m) =>
          m.id === action.messageId ? { ...m, failed: true } : m
        )
      })
      return { ...state, dms }
    }

    case 'LOAD_DM_HISTORY': {
      const dms = new Map(state.dms)
      const existing = dms.get(action.peerId)
      // Only load if conversation is empty (don't overwrite live messages)
      if (existing && existing.messages.length > 0) return state
      dms.set(action.peerId, {
        peerId: action.peerId,
        nickname: existing?.nickname ?? action.nickname,
        messages: action.messages,
        unread: action.unread
      })
      return { ...state, dms }
    }

    case 'SET_SHARED_FOLDERS': {
      // If the currently-indexing folder was removed, clear progress
      let indexingProgress = state.indexingProgress
      if (indexingProgress) {
        const stillShared = action.folders.some((f) => indexingProgress!.folder === f.path)
        if (!stillShared) {
          indexingProgress = null
        }
      }
      return { ...state, sharedFolders: action.folders, indexingProgress }
    }

    case 'BROWSE_LOADING':
      return { ...state, browseLoading: true, browseData: null, browseTarget: { userId: action.userId, nickname: action.nickname } }

    case 'BROWSE_DATA':
      return { ...state, browseLoading: false, browseData: action.data }

    case 'BROWSE_CLEAR':
      return { ...state, browseLoading: false, browseData: null, browseTarget: null }

    case 'SEARCH_START':
      return { ...state, searchResults: [], searchLoading: true, searchId: action.searchId }

    case 'SEARCH_RESULTS': {
      if (action.searchId !== state.searchId) return state
      return { ...state, searchResults: [...state.searchResults, ...action.results] }
    }

    case 'SEARCH_DONE':
      return { ...state, searchLoading: false }

    case 'SEARCH_CLEAR':
      return { ...state, searchResults: [], searchLoading: false, searchId: null }

    case 'TRANSFER_PROGRESS': {
      const transfers = new Map(state.transfers)
      const prev = transfers.get(action.transfer.contentHash)
      transfers.set(action.transfer.contentHash, {
        ...action.transfer,
        startedAt: action.transfer.startedAt ?? prev?.startedAt,
        activeDurationMs: action.transfer.activeDurationMs ?? prev?.activeDurationMs
      })
      return { ...state, transfers }
    }

    case 'TRANSFER_COMPLETE': {
      const transfers = new Map(state.transfers)
      const existing = transfers.get(action.contentHash)
      if (existing) {
        transfers.set(action.contentHash, {
          ...existing,
          status: 'complete',
          savePath: action.savePath,
          bytesDownloaded: action.size,
          bytesTotal: action.size
        })
      }
      return { ...state, transfers }
    }

    case 'TRANSFER_ERROR': {
      const transfers = new Map(state.transfers)
      const existing = transfers.get(action.contentHash)
      if (existing) {
        transfers.set(action.contentHash, {
          ...existing,
          status: 'failed',
          error: action.message
        })
      }
      return { ...state, transfers }
    }

    case 'TRANSFER_REMOVED': {
      const transfers = new Map(state.transfers)
      transfers.delete(action.contentHash)
      return { ...state, transfers }
    }

    case 'LOAD_TRANSFER_HISTORY': {
      const transfers = new Map(state.transfers)
      for (const r of action.records) {
        // Don't overwrite active downloads with history
        if (!transfers.has(r.contentHash)) {
          transfers.set(r.contentHash, {
            contentHash: r.contentHash,
            fileName: r.fileName,
            status: r.status,
            chunksReceived: 0,
            chunksTotal: 0,
            bytesDownloaded: r.bytesDownloaded ?? (r.status === 'complete' ? r.bytesTotal : 0),
            bytesTotal: r.bytesTotal,
            speedBps: 0,
            providers: 0,
            savePath: r.savePath,
            error: r.error,
            fileExists: r.fileExists,
            startedAt: r.startedAt,
            activeDurationMs: r.activeDurationMs
          })
        }
      }
      return { ...state, transfers }
    }

    case 'CLEAR_TRANSFER_HISTORY': {
      const transfers = new Map(state.transfers)
      // Only remove completed/failed/interrupted/paused — keep active downloads
      for (const [hash, t] of transfers) {
        if (t.status === 'complete' || t.status === 'failed' || t.status === 'interrupted' || t.status === 'paused') {
          transfers.delete(hash)
        }
      }
      return { ...state, transfers }
    }

    case 'UPLOAD_PROGRESS': {
      const uploads = new Map(state.uploads)
      const key = `${action.upload.peerId}:${action.upload.contentHash}`
      uploads.set(key, action.upload)
      return { ...state, uploads }
    }

    case 'UPLOAD_COMPLETE': {
      const uploads = new Map(state.uploads)
      const key = `${action.peerId}:${action.contentHash}`
      uploads.delete(key)
      return { ...state, uploads }
    }

    case 'INDEX_PROGRESS':
      return { ...state, indexingProgress: action.progress }

    case 'INDEX_COMPLETE':
      return { ...state, indexingProgress: null }

    case 'AVATAR_UPDATED': {
      const avatarSet = new Set(state.usersWithAvatar)
      if (action.hasAvatar) avatarSet.add(action.userId)
      else avatarSet.delete(action.userId)
      return { ...state, usersWithAvatar: avatarSet }
    }

    case 'NAT_STATUS':
      return { ...state, natStatus: action.status }

    case 'EXTERNAL_IP':
      return { ...state, externalIp: action.ip }

    case 'BOOTSTRAP_STATUS':
      return { ...state, bootstrapConnected: action.connected }

    case 'RELAY_STATUS':
      return { ...state, relayStatus: action.status, relayAddr: action.relayAddr }

    case 'SET_BLOCKED_USERS':
      return { ...state, blockedUsers: new Set(action.userIds) }

    case 'BLOCK_USER': {
      const blocked = new Set(state.blockedUsers)
      blocked.add(action.userId)
      return { ...state, blockedUsers: blocked }
    }

    case 'UNBLOCK_USER': {
      const blocked = new Set(state.blockedUsers)
      blocked.delete(action.userId)
      return { ...state, blockedUsers: blocked }
    }

    default:
      return state
  }
}

export interface P2PActions {
  connect: (config: { nickname: string }) => Promise<void>
  disconnect: () => Promise<void>
  joinRoom: (room: string) => Promise<void>
  leaveRoom: (room: string) => Promise<void>
  sendMessage: (room: string, text: string) => Promise<void>
  sendDm: (userId: string, text: string) => Promise<void>
  setNickname: (nickname: string) => Promise<void>
  setActiveRoom: (room: string) => void
  openDm: (peerId: string, nickname: string) => void
  clearDmUnread: (peerId: string) => void
  addSharedFolder: () => Promise<void>
  removeSharedFolder: (path: string) => Promise<void>
  loadSharedFolders: () => Promise<void>
  browseUser: (userId: string, nickname: string) => Promise<void>
  clearBrowse: () => void
  searchFiles: (query: string) => Promise<void>
  clearSearch: () => void
  downloadFile: (contentHash: string, fileName: string, relativePath?: string) => Promise<void>
  pauseDownload: (contentHash: string) => Promise<void>
  resumeDownload: (contentHash: string) => Promise<void>
  cancelDownload: (contentHash: string) => Promise<void>
  removeTransfer: (contentHash: string) => void
  clearTransferHistory: () => Promise<void>
  blockUser: (userId: string) => void
  unblockUser: (userId: string) => void
}

export interface P2PContextValue {
  state: P2PState
  actions: P2PActions
}

export const P2PContext = createContext<P2PContextValue | null>(null)

export function P2PProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const unsubRef = useRef<(() => void) | null>(null)
  const myPeerIdRef = useRef<string | null>(null)
  myPeerIdRef.current = state.myPeerId
  const blockedUsersRef = useRef<Set<string>>(new Set())
  blockedUsersRef.current = state.blockedUsers
  // Track last outgoing DM so we can mark it failed if hub reports offline
  const lastSentDmRef = useRef<{ peerId: string; messageId: string } | null>(null)
  const browseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interruptedRestarted = useRef(false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEvent = useCallback((eventName: string, data: any) => {
    switch (eventName) {
      case 'status': {
        const status = data as StatusData
        if (status.connected === false) {
          dispatch({ type: 'SET_DISCONNECTED' })
        } else if (status.peerCount !== undefined) {
          dispatch({
            type: 'STATUS_UPDATE',
            connected: true,
            peerCount: status.peerCount
          })
        }
        break
      }

      case 'message': {
        const msg = data as MessageData
        dispatch({
          type: 'MESSAGE_RECEIVED',
          room: msg.room,
          message: {
            id: msgId(),
            sender: msg.sender,
            nickname: msg.nickname,
            text: msg.text,
            timestamp: msg.timestamp
          }
        })
        break
      }

      case 'dm': {
        const dm = data as DmData
        // Skip hub echo of our own sent DMs — already added locally in sendDm()
        if (dm.sender === myPeerIdRef.current) break
        // Skip DMs from blocked users
        if (blockedUsersRef.current.has(dm.sender)) break
        playNotificationSound()
        dispatch({
          type: 'DM_RECEIVED',
          peerId: dm.sender,
          nickname: dm.nickname,
          message: {
            id: msgId(),
            sender: dm.sender,
            nickname: dm.nickname,
            text: dm.text,
            timestamp: dm.timestamp
          }
        })
        break
      }

      case 'peer_joined': {
        const peer = data as PeerEventData
        dispatch({
          type: 'PEER_JOINED',
          room: peer.room,
          peerId: peer.userId,
          nickname: peer.nickname,
          hasAvatar: peer.hasAvatar
        })
        break
      }

      case 'peer_left': {
        const peer = data as PeerEventData
        dispatch({
          type: 'PEER_LEFT',
          room: peer.room,
          peerId: peer.userId,
          nickname: peer.nickname
        })
        break
      }

      case 'room_history': {
        const history = data as RoomHistoryData
        // Collect avatar info from history senders
        const avatarUsers: string[] = []
        for (const m of history.messages) {
          if (m.hasAvatar && !avatarUsers.includes(m.sender)) {
            avatarUsers.push(m.sender)
          }
        }
        dispatch({
          type: 'ROOM_HISTORY',
          room: history.room,
          messages: history.messages.map((m) => ({
            id: msgId(),
            sender: m.sender,
            nickname: m.nickname,
            text: m.text,
            timestamp: m.timestamp
          })),
          avatarUsers
        })
        break
      }

      case 'member_list': {
        const memberList = data as MemberListData
        dispatch({
          type: 'MEMBER_LIST',
          room: memberList.room,
          members: memberList.members
        })
        break
      }

      case 'nickname_changed': {
        const nc = data as NicknameChangedData
        dispatch({
          type: 'NICKNAME_CHANGED',
          userId: nc.userId,
          oldNickname: nc.oldNickname,
          newNickname: nc.newNickname
        })
        break
      }

      case 'file_list_response': {
        const fileData = data as FileListData
        if (browseTimeoutRef.current) {
          clearTimeout(browseTimeoutRef.current)
          browseTimeoutRef.current = null
        }
        dispatch({ type: 'BROWSE_DATA', data: fileData })
        break
      }

      case 'file_search_response': {
        const d = data as { searchId: string; results: FileSearchResult[] }
        dispatch({ type: 'SEARCH_RESULTS', searchId: d.searchId, results: d.results })
        break
      }

      case 'error': {
        const err = data as ErrorData
        dispatch({ type: 'ERROR', message: err.message })
        // Detect "User X is not online" and mark the last sent DM as failed
        const offlineMatch = err.message.match(/^User (\w+) is not online$/)
        if (offlineMatch && lastSentDmRef.current) {
          const targetId = offlineMatch[1]
          if (lastSentDmRef.current.peerId === targetId) {
            dispatch({
              type: 'MARK_DM_FAILED',
              peerId: targetId,
              messageId: lastSentDmRef.current.messageId
            })
            lastSentDmRef.current = null
          }
        }
        break
      }

      case 'p2p_multiaddr': {
        // A hub peer shared their libp2p multiaddr — add them to our p2p node
        const d = data as { userId: string; multiaddr: string }
        window.api.addPeer(d.multiaddr).catch(() => {})
        break
      }

      case 'avatar_updated': {
        const av = data as AvatarUpdatedData
        if (av.hasAvatar) bumpAvatarCacheBust()
        dispatch({ type: 'AVATAR_UPDATED', userId: av.userId, hasAvatar: av.hasAvatar })
        break
      }
    }
  }, [])

  // On mount, check if the main process already has an active connection (e.g. after page refresh)
  useEffect(() => {
    let cancelled = false

    // Restore all DM conversations from encrypted store (unread badges, history)
    window.api.loadAllDmConversations().then((allConvos) => {
      if (cancelled) return
      for (const [peerId, convo] of Object.entries(allConvos)) {
        if (convo.messages.length > 0) {
          dispatch({
            type: 'LOAD_DM_HISTORY',
            peerId,
            nickname: convo.nickname || peerId.slice(0, 8),
            messages: convo.messages as ChatMessage[],
            unread: convo.unread
          })
        }
      }
    })

    window.api.getSharedFolders().then((folders) => {
      if (cancelled) return
      dispatch({ type: 'SET_SHARED_FOLDERS', folders: folders as SharedFolder[] })
    })

    // Restore transfer history from disk
    window.api.getTransferHistory().then((records) => {
      if (cancelled || !records.length) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatch({ type: 'LOAD_TRANSFER_HISTORY', records: records as any })
    })

    // Restore active downloads from main process (survives renderer refresh)
    window.api.getActiveDownloads().then((active) => {
      if (cancelled) return
      const list = active as Array<{
        contentHash: string; fileName: string; status: string
        chunksReceived: number; chunksTotal: number
        bytesDownloaded: number; bytesTotal: number
        speedBps: number; providers: number
        startedAt?: number; activeDurationMs?: number
      }>
      for (const dl of list) {
        const statusMap: Record<string, TransferInfo['status']> = {
          finding_providers: 'finding_providers',
          requesting_metadata: 'requesting_metadata',
          downloading: 'downloading',
          paused: 'paused'
        }
        dispatch({
          type: 'TRANSFER_PROGRESS',
          transfer: {
            contentHash: dl.contentHash,
            fileName: dl.fileName,
            status: statusMap[dl.status] ?? 'downloading',
            chunksReceived: dl.chunksReceived,
            chunksTotal: dl.chunksTotal,
            bytesDownloaded: dl.bytesDownloaded,
            bytesTotal: dl.bytesTotal,
            speedBps: dl.speedBps,
            providers: dl.providers,
            startedAt: dl.startedAt,
            activeDurationMs: dl.activeDurationMs
          }
        })
      }
    }).catch(() => {})

    window.api.getState().then((mainState) => {
      if (cancelled) return

      if (mainState.connected && mainState.userId && mainState.nickname) {
        // Re-subscribe to events from the main process
        unsubRef.current?.()
        unsubRef.current = window.api.onEvent(handleEvent)

        // Restore connection state
        dispatch({ type: 'SET_CONNECTED', peerId: mainState.userId, nickname: mainState.nickname })
        if (mainState.peerCount > 0) {
          dispatch({ type: 'STATUS_UPDATE', connected: true, peerCount: mainState.peerCount })
        }

        // Restore NAT status from main process cache
        window.api.getNatStatus().then((status) => {
          if (cancelled) return
          const s = status === 'public' ? 'public' : status === 'private' ? 'private' : 'unknown'
          dispatch({ type: 'NAT_STATUS', status: s })
        }).catch(() => {})

        // Restore external IP from main process cache
        window.api.getExternalIp().then((ip) => {
          if (cancelled || !ip) return
          dispatch({ type: 'EXTERNAL_IP', ip })
        }).catch(() => {})

        // Restore bootstrap connection status from main process cache
        window.api.getBootstrapStatus().then((connected) => {
          if (cancelled) return
          dispatch({ type: 'BOOTSTRAP_STATUS', connected })
        }).catch(() => {})

        // Restore relay status from main process cache
        window.api.getRelayStatus().then((relay) => {
          if (cancelled) return
          dispatch({
            type: 'RELAY_STATUS',
            status: relay.status as 'none' | 'reserving' | 'reserved' | 'failed',
            relayAddr: relay.relayAddr || null
          })
        }).catch(() => {})

        // Re-join rooms to get fresh history and member lists from the hub
        for (const room of mainState.rooms) {
          dispatch({ type: 'ROOM_JOINED', room })
          // Request fresh room data from the hub (the server will send room_history + member_list)
          window.api.joinRoom(room)
        }
      }

      dispatch({ type: 'SET_LOADING', loading: false })
    })

    // Load blocked users from persisted settings
    window.api.loadSettings().then((settings) => {
      if (cancelled) return
      const blocked = (settings as { blockedUsers?: string[] }).blockedUsers
      if (blocked?.length) {
        dispatch({ type: 'SET_BLOCKED_USERS', userIds: blocked })
      }
    }).catch(() => {})

    return () => {
      cancelled = true
      unsubRef.current?.()
    }
  }, [])

  // Listen for P2P (libp2p) node events — transfers, indexing, etc.
  useEffect(() => {
    const unsub = window.api.onP2PEvent((eventJson: string) => {
      try {
        const event = JSON.parse(eventJson)
        switch (event.type) {
          case 'DownloadProgress': {
            const d = event.data
            const statusMap: Record<string, TransferInfo['status']> = {
              finding_providers: 'finding_providers',
              requesting_metadata: 'requesting_metadata',
              downloading: 'downloading',
              paused: 'paused'
            }
            dispatch({
              type: 'TRANSFER_PROGRESS',
              transfer: {
                contentHash: d.content_hash,
                fileName: d.file_name,
                status: statusMap[d.status] ?? 'downloading',
                chunksReceived: d.chunks_received,
                chunksTotal: d.chunks_total,
                bytesDownloaded: d.bytes_downloaded,
                bytesTotal: d.bytes_total,
                speedBps: d.speed_bps,
                providers: d.providers
              }
            })
            break
          }
          case 'DownloadComplete': {
            const d = event.data
            dispatch({
              type: 'TRANSFER_COMPLETE',
              contentHash: d.content_hash,
              savePath: d.save_path,
              size: d.size
            })
            break
          }
          case 'DownloadError': {
            const d = event.data
            dispatch({
              type: 'TRANSFER_ERROR',
              contentHash: d.content_hash,
              message: d.message
            })
            break
          }
          case 'UploadProgress': {
            const d = event.data
            dispatch({
              type: 'UPLOAD_PROGRESS',
              upload: {
                contentHash: d.content_hash,
                fileName: d.file_name,
                peerId: d.peer_id,
                nickname: d.nickname,
                chunksServed: d.chunks_served,
                chunksTotal: d.chunks_total,
                bytesSent: d.bytes_sent,
                bytesTotal: d.bytes_total,
                speedBps: d.speed_bps
              }
            })
            break
          }
          case 'UploadComplete': {
            const d = event.data
            dispatch({
              type: 'UPLOAD_COMPLETE',
              contentHash: d.content_hash,
              peerId: d.peer_id
            })
            break
          }
          case 'IndexProgress': {
            const d = event.data
            dispatch({
              type: 'INDEX_PROGRESS',
              progress: {
                folder: d.folder,
                filesScanned: d.files_scanned,
                filesTotal: d.files_total,
                currentFile: d.current_file
              }
            })
            break
          }
          case 'IndexComplete': {
            const d = event.data
            dispatch({ type: 'INDEX_COMPLETE', folder: d.folder, fileCount: d.file_count })
            break
          }
          case 'Status': {
            // When p2p node connects to peers, restart any interrupted downloads
            const d = event.data as { connected: boolean; peer_count: number }
            if (d.connected && d.peer_count > 0 && !interruptedRestarted.current) {
              interruptedRestarted.current = true
              // Small delay to let connections stabilize
              setTimeout(() => {
                window.api.getTransferHistory().then((records) => {
                  for (const r of records) {
                    if ((r as { status: string }).status === 'interrupted') {
                      const rec = r as { contentHash: string; fileName: string; startedAt?: number; activeDurationMs?: number }
                      window.api.startDownload(rec.contentHash, rec.fileName).then(() => {
                        window.api.removeTransferHistory(rec.contentHash)
                      }).catch(() => {})
                      dispatch({
                        type: 'TRANSFER_PROGRESS',
                        transfer: {
                          contentHash: rec.contentHash,
                          fileName: rec.fileName,
                          status: 'finding_providers',
                          chunksReceived: 0,
                          chunksTotal: 0,
                          bytesDownloaded: 0,
                          bytesTotal: 0,
                          speedBps: 0,
                          providers: 0,
                          startedAt: rec.startedAt,
                          activeDurationMs: rec.activeDurationMs
                        }
                      })
                    }
                  }
                })
              }, 2000)
            }
            break
          }
          case 'ListenAddr': {
            // Share our libp2p multiaddr with other hub peers
            const d = event.data
            window.api.sendMultiaddr(d.multiaddr).catch(() => {})
            break
          }
          case 'NatStatus': {
            const d = event.data as { status: string }
            const s = d.status === 'public' ? 'public' : d.status === 'private' ? 'private' : 'unknown'
            dispatch({ type: 'NAT_STATUS', status: s })
            break
          }
          case 'ExternalAddr': {
            const d = event.data as { address: string }
            dispatch({ type: 'EXTERNAL_IP', ip: d.address })
            break
          }
          case 'BootstrapStatus': {
            const d = event.data as { connected: boolean }
            dispatch({ type: 'BOOTSTRAP_STATUS', connected: d.connected })
            break
          }
          case 'RelayStatus': {
            const d = event.data as { status: string; relay_addr: string | null }
            dispatch({
              type: 'RELAY_STATUS',
              status: d.status as 'none' | 'reserving' | 'reserved' | 'failed',
              relayAddr: d.relay_addr ?? null
            })
            break
          }
        }
      } catch {
        // ignore malformed events
      }
    })
    return () => unsub()
  }, [])

  // Auto-save DM conversations to encrypted store (debounced)
  const dmStateKey = Array.from(state.dms.values())
    .map((dm) => `${dm.messages.length}:${dm.unread}`)
    .join(',')
  const initialLoadRef = useRef(true)
  useEffect(() => {
    // Skip the initial render (before any real messages exist)
    if (initialLoadRef.current) {
      initialLoadRef.current = false
      return
    }
    if (state.dms.size === 0) return
    const timer = setTimeout(() => {
      for (const [peerId, dm] of state.dms) {
        if (dm.messages.length > 0) {
          window.api.saveDmConversation(peerId, {
            messages: dm.messages,
            unread: dm.unread,
            nickname: dm.nickname
          })
        }
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [dmStateKey])

  const actions: P2PActions = {
    connect: async (config) => {
      try {
        unsubRef.current?.()
        unsubRef.current = window.api.onEvent(handleEvent)

        const userId = await window.api.connect({
          nickname: config.nickname
        })

        dispatch({ type: 'SET_CONNECTED', peerId: userId, nickname: config.nickname })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
        throw err
      }
    },

    disconnect: async () => {
      try {
        await window.api.disconnect()
        unsubRef.current?.()
        unsubRef.current = null
        dispatch({ type: 'SET_DISCONNECTED' })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    joinRoom: async (room) => {
      try {
        await window.api.joinRoom(room)
        dispatch({ type: 'ROOM_JOINED', room })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    leaveRoom: async (room) => {
      try {
        await window.api.leaveRoom(room)
        dispatch({ type: 'ROOM_LEFT', room })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    sendMessage: async (room, text) => {
      try {
        await window.api.sendMessage(room, text)
        // No local injection — hub echoes the message back via 'message' event
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    sendDm: async (userId, text) => {
      try {
        const id = msgId()
        // Self-DM (Saved Messages): store locally only, skip hub
        if (userId === state.myPeerId) {
          dispatch({
            type: 'DM_RECEIVED',
            peerId: userId,
            nickname: i18n.t('chat.savedMessages'),
            message: {
              id,
              sender: state.myPeerId!,
              nickname: state.nickname,
              text,
              timestamp: Date.now()
            }
          })
          return
        }
        lastSentDmRef.current = { peerId: userId, messageId: id }
        await window.api.sendDm(userId, text)
        // Add sent message locally so the sender sees it in the DM conversation
        // Use the partner's nickname for the conversation label, not our own
        const existingDm = state.dms.get(userId)
        dispatch({
          type: 'DM_RECEIVED',
          peerId: userId,
          nickname: existingDm?.nickname ?? userId.slice(0, 8),
          message: {
            id,
            sender: state.myPeerId!,
            nickname: state.nickname,
            text,
            timestamp: Date.now()
          }
        })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    setNickname: async (nickname) => {
      try {
        await window.api.setNickname(nickname)
        dispatch({ type: 'SET_NICKNAME', nickname })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    setActiveRoom: (room) => {
      dispatch({ type: 'SET_ACTIVE_ROOM', room })
      dispatch({ type: 'CLEAR_UNREAD', room })
    },

    openDm: (peerId, nickname) => {
      dispatch({ type: 'OPEN_DM', peerId, nickname })
      dispatch({ type: 'CLEAR_DM_UNREAD', peerId })
      // Load history from encrypted store if conversation is empty
      if (!state.dms.has(peerId) || state.dms.get(peerId)!.messages.length === 0) {
        window.api.loadDmConversation(peerId).then((convo) => {
          if (convo && convo.messages.length > 0) {
            dispatch({
              type: 'LOAD_DM_HISTORY',
              peerId,
              nickname: convo.nickname || nickname,
              messages: convo.messages as ChatMessage[],
              unread: 0 // Opening the tab clears unread
            })
          }
        })
      }
    },

    clearDmUnread: (peerId) => {
      dispatch({ type: 'CLEAR_DM_UNREAD', peerId })
    },

    addSharedFolder: async () => {
      try {
        const folders = await window.api.addSharedFolder()
        if (folders) {
          dispatch({ type: 'SET_SHARED_FOLDERS', folders: folders as SharedFolder[] })
        }
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    removeSharedFolder: async (path: string) => {
      try {
        const folders = await window.api.removeSharedFolder(path)
        dispatch({ type: 'SET_SHARED_FOLDERS', folders: folders as SharedFolder[] })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    loadSharedFolders: async () => {
      try {
        const folders = await window.api.getSharedFolders()
        dispatch({ type: 'SET_SHARED_FOLDERS', folders: folders as SharedFolder[] })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    browseUser: async (userId: string, nickname: string) => {
      dispatch({ type: 'BROWSE_LOADING', userId, nickname })
      if (browseTimeoutRef.current) clearTimeout(browseTimeoutRef.current)
      try {
        await window.api.browseUser(userId)
        // Response arrives asynchronously via file_list_response event
        browseTimeoutRef.current = setTimeout(() => {
          dispatch({ type: 'ERROR', message: i18n.t('browse.timeout', { name: nickname }) })
          dispatch({ type: 'BROWSE_CLEAR' })
          browseTimeoutRef.current = null
        }, 10000)
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
        dispatch({ type: 'BROWSE_CLEAR' })
      }
    },

    clearBrowse: () => {
      dispatch({ type: 'BROWSE_CLEAR' })
    },

    searchFiles: async (query: string) => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
      try {
        const searchId = await window.api.searchFiles(query)
        dispatch({ type: 'SEARCH_START', searchId })
        searchTimeoutRef.current = setTimeout(() => {
          dispatch({ type: 'SEARCH_DONE' })
          searchTimeoutRef.current = null
        }, 5000)
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    clearSearch: () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
      dispatch({ type: 'SEARCH_CLEAR' })
    },

    downloadFile: async (contentHash: string, fileName: string, relativePath?: string) => {
      try {
        // Immediately show the transfer in the UI
        dispatch({
          type: 'TRANSFER_PROGRESS',
          transfer: {
            contentHash,
            fileName,
            status: 'finding_providers',
            chunksReceived: 0,
            chunksTotal: 0,
            bytesDownloaded: 0,
            bytesTotal: 0,
            speedBps: 0,
            providers: 0
          }
        })
        await window.api.startDownload(contentHash, fileName, relativePath)
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    pauseDownload: async (contentHash: string) => {
      try {
        await window.api.pauseDownload(contentHash)
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    resumeDownload: async (contentHash: string) => {
      try {
        // Main process handles both live paused and history records —
        // it checks activeDownloads map and falls back to startDownload if needed
        const transfer = state.transfers.get(contentHash)
        if (transfer) {
          dispatch({
            type: 'TRANSFER_PROGRESS',
            transfer: { ...transfer, status: 'finding_providers' }
          })
        }
        await window.api.resumeDownload(contentHash)
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    cancelDownload: async (contentHash: string) => {
      try {
        await window.api.cancelDownload(contentHash)
        dispatch({ type: 'TRANSFER_REMOVED', contentHash })
      } catch (err) {
        dispatch({ type: 'ERROR', message: String(err) })
      }
    },

    removeTransfer: (contentHash: string) => {
      // Try to cancel on Rust side (for live paused downloads), ignore errors
      window.api.cancelDownload(contentHash).catch(() => {})
      dispatch({ type: 'TRANSFER_REMOVED', contentHash })
      window.api.removeTransferHistory(contentHash)
    },

    clearTransferHistory: async () => {
      await window.api.clearTransferHistory()
      dispatch({ type: 'CLEAR_TRANSFER_HISTORY' })
    },

    blockUser: (userId: string) => {
      dispatch({ type: 'BLOCK_USER', userId })
      const next = new Set(state.blockedUsers)
      next.add(userId)
      window.api.saveSettings({ blockedUsers: [...next] })
    },

    unblockUser: (userId: string) => {
      dispatch({ type: 'UNBLOCK_USER', userId })
      const next = new Set(state.blockedUsers)
      next.delete(userId)
      window.api.saveSettings({ blockedUsers: [...next] })
    }
  }

  return <P2PContext.Provider value={{ state, actions }}>{children}</P2PContext.Provider>
}
