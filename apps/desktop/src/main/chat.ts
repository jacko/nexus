import { ipcMain, BrowserWindow } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { io, Socket } from 'socket.io-client'
import {
  loadOrCreateIdentity,
  signChallenge,
  getStoredNickname,
  saveNickname,
  hasIdentity,
  generateMnemonic,
  createIdentityFromMnemonic,
  validateMnemonic,
  Identity
} from './identity'
import {
  initMessageStore,
  loadDmConversation,
  loadAllDmConversations,
  saveDmConversation,
  StoredConversation
} from './message-store'
import { getFileListForRemote, getSharedFolderPaths, searchSharedFiles } from './file-share'
import { startP2PNode, indexFolderIfRunning, isP2PRunning } from './p2p'
import { HUB_URL, BOOTSTRAP_PEERS } from '../shared/config'

let socket: Socket | null = null
let identity: Identity | null = null
let mainWindowRef: BrowserWindow | null = null

// Track connection state so the renderer can restore after page refresh
interface ChatState {
  connected: boolean
  userId: string | null
  nickname: string | null
  rooms: string[]
  peerCount: number
}

const chatState: ChatState = {
  connected: false,
  userId: null,
  nickname: null,
  rooms: [],
  peerCount: 0
}

let storeInitialized = false

export function getIdentity(): Identity {
  if (!identity) {
    const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
    const identityPath = join(dataDir, 'identity.json')
    identity = loadOrCreateIdentity(identityPath)
    if (!storeInitialized) {
      initMessageStore(dataDir, identity.privateKey)
      storeInitialized = true
    }
  }
  return identity
}

function sendToRenderer(mainWindow: BrowserWindow, event: string, data: unknown): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chat:event', event, data)
  }
}

export function setupChat(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
  ipcMain.handle(
    'chat:connect',
    async (_event, config: { nickname: string }) => {
      if (socket) {
        socket.disconnect()
        socket = null
      }

      const id = getIdentity()

      return new Promise<string>((resolve, reject) => {
        socket = io(HUB_URL, {
          auth: {
            nickname: config.nickname,
            publicKey: id.publicKeyHex
          },
          transports: ['websocket'],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 10000
        })

        let authenticated = false

        // Auth challenge-response
        socket.on('auth_challenge', (data: { nonce: string }) => {
          const signature = signChallenge(id.privateKey, data.nonce)
          socket!.emit('auth_response', { signature })
        })

        socket.on('auth_success', (data: { userId: string }) => {
          authenticated = true
          chatState.connected = true
          chatState.userId = data.userId
          chatState.nickname = config.nickname
          chatState.rooms = []
          // Persist nickname to identity config
          saveNickname(id.identityPath, config.nickname)
          resolve(data.userId)

          // Auto-start p2p node and index shared folders
          if (!isP2PRunning()) {
            startP2PNode(mainWindow, { nickname: config.nickname, bootstrapPeers: BOOTSTRAP_PEERS })
              .then(() => {
                console.log('[chat] P2P node started, indexing shared folders...')
                const folderPaths = getSharedFolderPaths()
                console.log('[chat] Shared folders to index:', folderPaths)
                for (const fp of folderPaths) {
                  indexFolderIfRunning(fp).catch((err) => {
                    console.error('[chat] Failed to index folder:', fp, err)
                  })
                }
              })
              .catch((err) => {
                console.error('[chat] Failed to start P2P node:', err)
              })
          }
        })

        // Forward all server events to renderer
        const events = [
          'status',
          'message',
          'dm',
          'peer_joined',
          'peer_left',
          'room_history',
          'member_list',
          'error',
          'nickname_changed',
          'file_list_response',
          'file_search_response',
          'p2p_multiaddr',
          'avatar_updated'
        ]

        for (const eventName of events) {
          socket.on(eventName, (data: unknown) => {
            // Track peer count from status events
            if (eventName === 'status' && data && typeof data === 'object') {
              const statusData = data as { peerCount?: number }
              if (statusData.peerCount !== undefined) {
                chatState.peerCount = statusData.peerCount
              }
            }
            sendToRenderer(mainWindow, eventName, data)
          })
        }

        // Respond to file list browse requests from other users
        socket.on(
          'file_list_request',
          (data: { requesterId: string; requesterNickname: string }) => {
            const fileList = getFileListForRemote(
              chatState.nickname ?? 'Anonymous',
              chatState.userId ?? ''
            )
            socket!.emit('file_list_response', {
              requesterId: data.requesterId,
              data: fileList
            })
          }
        )

        // Respond to file search requests from other users
        socket.on(
          'file_search_request',
          (data: { searchId: string; query: string; requesterId: string }) => {
            const results = searchSharedFiles(
              data.query,
              chatState.nickname ?? 'Anonymous',
              chatState.userId ?? ''
            )
            if (results.length > 0) {
              socket!.emit('file_search_response', {
                searchId: data.searchId,
                requesterId: data.requesterId,
                results
              })
            }
          }
        )

        // Connection lifecycle
        socket.on('connect', () => {
          if (authenticated) {
            // Reconnection — re-auth happens automatically via Socket.IO auth
            sendToRenderer(mainWindow, 'status', {
              connected: true,
              reconnected: true
            })
          }
        })

        socket.on('disconnect', (reason: string) => {
          sendToRenderer(mainWindow, 'status', {
            connected: false,
            peerCount: 0,
            reason
          })
        })

        socket.on('connect_error', () => {
          const friendly = 'Hub server is not available'
          if (!authenticated) {
            reject(friendly)
          } else {
            sendToRenderer(mainWindow, 'error', {
              message: friendly
            })
          }
        })

        // Timeout for initial auth
        setTimeout(() => {
          if (!authenticated) {
            socket?.disconnect()
            reject('Hub server did not respond')
          }
        }, 10000)
      })
    }
  )

  ipcMain.handle('chat:disconnect', async () => {
    if (socket) {
      socket.disconnect()
      socket = null
    }
    chatState.connected = false
    chatState.userId = null
    chatState.nickname = null
    chatState.rooms = []
    chatState.peerCount = 0
  })

  ipcMain.handle('chat:joinRoom', async (_event, room: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    socket.emit('join_room', { room })
    if (!chatState.rooms.includes(room)) {
      chatState.rooms.push(room)
    }
  })

  ipcMain.handle('chat:leaveRoom', async (_event, room: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    socket.emit('leave_room', { room })
    chatState.rooms = chatState.rooms.filter((r) => r !== room)
  })

  ipcMain.handle('chat:sendMessage', async (_event, room: string, text: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    socket.emit('message', { room, text })
  })

  ipcMain.handle('chat:sendDm', async (_event, userId: string, text: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    socket.emit('dm', { targetId: userId, text })
  })

  ipcMain.handle('chat:setNickname', async (_event, nickname: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    socket.emit('set_nickname', { nickname })
    chatState.nickname = nickname
    const id = getIdentity()
    saveNickname(id.identityPath, nickname)
  })

  ipcMain.handle('chat:getState', async () => {
    return {
      connected: chatState.connected && (socket?.connected ?? false),
      userId: chatState.userId,
      nickname: chatState.nickname,
      rooms: chatState.rooms,
      peerCount: chatState.peerCount
    }
  })

  ipcMain.handle('chat:getStoredNickname', async () => {
    const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
    const identityPath = join(dataDir, 'identity.json')
    return getStoredNickname(identityPath)
  })

  ipcMain.handle('chat:loadDmConversation', async (_event, peerId: string) => {
    const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
    if (!existsSync(join(dataDir, 'identity.json'))) return null
    getIdentity() // ensure store is initialized
    return loadDmConversation(peerId)
  })

  ipcMain.handle('chat:loadAllDmConversations', async () => {
    const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
    if (!existsSync(join(dataDir, 'identity.json'))) return {}
    getIdentity() // ensure store is initialized
    return loadAllDmConversations()
  })

  ipcMain.handle(
    'chat:saveDmConversation',
    async (_event, peerId: string, conversation: unknown) => {
      const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
      if (!existsSync(join(dataDir, 'identity.json'))) return
      getIdentity() // ensure store is initialized
      saveDmConversation(peerId, conversation as StoredConversation)
    }
  )

  ipcMain.handle('shares:browseUser', async (_event, userId: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    socket.emit('file_list_request', { targetId: userId })
  })

  ipcMain.handle('shares:searchFiles', async (_event, query: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    const searchId = `${chatState.userId}-${Date.now()}`
    socket.emit('file_search', { searchId, query })
    return searchId
  })

  ipcMain.handle('chat:sendMultiaddr', async (_event, multiaddr: string) => {
    if (!socket?.connected) throw new Error('Hub server is not connected')
    socket.emit('p2p_multiaddr', { multiaddr })
  })

  // Identity management
  ipcMain.handle('identity:hasIdentity', async () => {
    const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
    return hasIdentity(join(dataDir, 'identity.json'))
  })

  ipcMain.handle('identity:generateMnemonic', async () => {
    return generateMnemonic()
  })

  ipcMain.handle('identity:createFromMnemonic', async (_event, mnemonic: string, nickname: string) => {
    const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
    const jsonPath = join(dataDir, 'identity.json')
    const keyPath = join(dataDir, 'identity.key')
    identity = createIdentityFromMnemonic(mnemonic, nickname, jsonPath, keyPath)
    if (!storeInitialized) {
      initMessageStore(dataDir, identity.privateKey)
      storeInitialized = true
    }
    return identity.userId
  })

  ipcMain.handle('identity:validateMnemonic', async (_event, mnemonic: string) => {
    return validateMnemonic(mnemonic)
  })
}

export function emitAvatarUpdated(hasAvatar: boolean): void {
  if (socket?.connected) {
    socket.emit('avatar_updated', { hasAvatar })
  }
  // Also notify own renderer (hub broadcasts to others but not back to sender)
  if (mainWindowRef && !mainWindowRef.isDestroyed() && chatState.userId) {
    mainWindowRef.webContents.send('chat:event', 'avatar_updated', {
      userId: chatState.userId,
      hasAvatar
    })
  }
}

export function shutdownChat(): void {
  if (socket) {
    socket.disconnect()
    socket = null
  }
  chatState.connected = false
  chatState.userId = null
  chatState.nickname = null
  chatState.rooms = []
  chatState.peerCount = 0
}
