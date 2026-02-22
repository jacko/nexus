import { ipcMain, BrowserWindow, shell } from 'electron'
import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import {
  addTransferRecord,
  getTransferHistory,
  clearTransferHistory,
  removeTransferRecord
} from './transfer-store'
import { loadSettings } from './settings'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NexusNode } = require('@nexus/p2p-core')

let node: InstanceType<typeof NexusNode> | null = null

// Content hash map built from IndexComplete events
// folder → array of { contentHash, relativePath, size }
interface IndexedFile {
  contentHash: string
  relativePath: string
  size: number
}

const folderIndex = new Map<string, IndexedFile[]>()

// Track active downloads so we can save them as 'interrupted' on shutdown
// and restore state after renderer refresh
interface ActiveDownloadInfo {
  fileName: string
  bytesTotal: number
  bytesDownloaded: number
  chunksReceived: number
  chunksTotal: number
  speedBps: number
  providers: number
  status: string
  startedAt: number
  activeDurationMs: number
  sessionActiveStart: number | null
  savePath: string
}
const activeDownloads = new Map<string, ActiveDownloadInfo>()
let cachedNatStatus: string = 'unknown'
let cachedExternalIp: string = ''
let cachedBootstrapConnected: boolean = false
let cachedRelayStatus: string = 'none'
let cachedRelayAddr: string = ''

export function getIndexedFiles(): Map<string, IndexedFile[]> {
  return folderIndex
}

export function isP2PRunning(): boolean {
  return node !== null
}

export async function startP2PNode(
  mainWindow: BrowserWindow,
  config: { nickname: string; bootstrapPeers?: string[] }
): Promise<string> {
  if (node) return '' // already running

  node = new NexusNode()
  const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
  const identityPath = join(dataDir, 'identity.key')

  const peerId = await node.start(
    {
      listenPort: 0,
      bootstrapPeers: config.bootstrapPeers ?? [],
      nickname: config.nickname,
      identityPath
    },
    (eventJson: string) => {
      // Intercept events to build indexes and persist transfer history
      try {
        const event = JSON.parse(eventJson)
        if (event.type === 'IndexComplete' && event.data) {
          const d = event.data as {
            folder: string
            files: Array<{ content_hash: string; relative_path: string; size: number }>
          }
          if (d.folder && Array.isArray(d.files)) {
            folderIndex.set(
              d.folder,
              d.files.map((f) => ({
                contentHash: f.content_hash,
                relativePath: f.relative_path,
                size: f.size
              }))
            )
          }
        } else if (event.type === 'DownloadProgress' && event.data) {
          const d = event.data as {
            content_hash: string
            file_name: string
            bytes_total: number
            bytes_downloaded: number
            chunks_received: number
            chunks_total: number
            speed_bps: number
            providers: number
            status: string
          }
          const existing = activeDownloads.get(d.content_hash)
          let startedAt = existing?.startedAt ?? Date.now()
          let activeDurationMs = existing?.activeDurationMs ?? 0
          let sessionActiveStart = existing?.sessionActiveStart ?? null

          const wasActive = existing?.status === 'downloading'
          const isNowActive = d.status === 'downloading'
          if (!wasActive && isNowActive) {
            sessionActiveStart = Date.now()
          } else if (wasActive && !isNowActive && sessionActiveStart !== null) {
            activeDurationMs += Date.now() - sessionActiveStart
            sessionActiveStart = null
          }

          activeDownloads.set(d.content_hash, {
            fileName: d.file_name,
            bytesTotal: d.bytes_total,
            bytesDownloaded: d.bytes_downloaded,
            chunksReceived: d.chunks_received,
            chunksTotal: d.chunks_total,
            speedBps: d.speed_bps,
            providers: d.providers,
            status: d.status,
            startedAt,
            activeDurationMs,
            sessionActiveStart,
            savePath: existing?.savePath ?? ''
          })
        } else if (event.type === 'DownloadComplete' && event.data) {
          const d = event.data as {
            content_hash: string
            file_name: string
            save_path: string
            size: number
          }
          const info = activeDownloads.get(d.content_hash)
          let activeDurationMs = info?.activeDurationMs ?? 0
          if (info?.sessionActiveStart !== null && info?.sessionActiveStart !== undefined) {
            activeDurationMs += Date.now() - info.sessionActiveStart
          }
          activeDownloads.delete(d.content_hash)
          addTransferRecord({
            contentHash: d.content_hash,
            fileName: d.file_name,
            status: 'complete',
            bytesTotal: d.size,
            savePath: d.save_path,
            completedAt: Date.now(),
            startedAt: info?.startedAt,
            activeDurationMs
          })
        } else if (event.type === 'NatStatus' && event.data) {
          cachedNatStatus = (event.data as { status: string }).status
        } else if (event.type === 'ExternalAddr' && event.data) {
          cachedExternalIp = (event.data as { address: string }).address
        } else if (event.type === 'BootstrapStatus' && event.data) {
          cachedBootstrapConnected = (event.data as { connected: boolean }).connected
        } else if (event.type === 'RelayStatus' && event.data) {
          const d = event.data as { status: string; relay_addr: string | null }
          cachedRelayStatus = d.status
          cachedRelayAddr = d.relay_addr ?? ''
        } else if (event.type === 'DownloadError' && event.data) {
          const d = event.data as {
            content_hash: string
            file_name: string
            message: string
          }
          const info = activeDownloads.get(d.content_hash)
          let activeDurationMs = info?.activeDurationMs ?? 0
          if (info?.sessionActiveStart !== null && info?.sessionActiveStart !== undefined) {
            activeDurationMs += Date.now() - info.sessionActiveStart
          }
          activeDownloads.delete(d.content_hash)
          addTransferRecord({
            contentHash: d.content_hash,
            fileName: d.file_name,
            status: 'failed',
            bytesTotal: info?.bytesTotal ?? 0,
            error: d.message,
            completedAt: Date.now(),
            startedAt: info?.startedAt,
            activeDurationMs
          })
        }
      } catch {
        // ignore parse errors
      }

      // Forward to renderer
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p:event', eventJson)
      }
    }
  )

  return peerId
}

export async function indexFolderIfRunning(folderPath: string): Promise<void> {
  if (node) {
    console.log('[p2p] Indexing folder:', folderPath)
    await node.indexFolder(folderPath)
  } else {
    console.log('[p2p] Skipping index (node not running):', folderPath)
  }
}

export function setupP2P(mainWindow: BrowserWindow): void {
  ipcMain.handle('p2p:start', async (_event, config) => {
    return startP2PNode(mainWindow, {
      nickname: config.nickname ?? 'Anonymous',
      bootstrapPeers: config.bootstrapPeers ?? []
    })
  })

  ipcMain.handle('p2p:joinRoom', async (_event, room: string) => {
    if (!node) throw new Error('Node not started')
    await node.joinRoom(room)
  })

  ipcMain.handle('p2p:leaveRoom', async (_event, room: string) => {
    if (!node) throw new Error('Node not started')
    await node.leaveRoom(room)
  })

  ipcMain.handle('p2p:sendMessage', async (_event, room: string, text: string) => {
    if (!node) throw new Error('Node not started')
    await node.sendMessage(room, text)
  })

  ipcMain.handle('p2p:sendDm', async (_event, peerId: string, text: string) => {
    if (!node) throw new Error('Node not started')
    await node.sendDm(peerId, text)
  })

  ipcMain.handle('p2p:setNickname', async (_event, nickname: string) => {
    if (!node) throw new Error('Node not started')
    await node.setNickname(nickname)
  })

  ipcMain.handle('p2p:getPeers', async () => {
    if (!node) throw new Error('Node not started')
    await node.getPeers()
  })

  ipcMain.handle('p2p:stop', async () => {
    if (node) {
      await node.stop()
      node = null
    }
  })

  ipcMain.handle('p2p:indexFolder', async (_event, path: string) => {
    if (!node) throw new Error('Node not started')
    await node.indexFolder(path)
  })

  ipcMain.handle('p2p:getFileIndex', async () => {
    if (!node) throw new Error('Node not started')
    await node.getFileIndex()
  })

  ipcMain.handle('transfers:download', async (_event, hash: string, fileName: string, relativePath?: string) => {
    if (!node) throw new Error('Node not started')
    const baseDir = loadSettings().downloadFolder || join(app.getPath('downloads'), 'Nexus')
    const savePath = join(baseDir, relativePath || fileName)
    // Create parent directories if needed (for folder downloads)
    mkdirSync(dirname(savePath), { recursive: true })
    // Carry forward timing from interrupted/paused history record (auto-restart case)
    const history = getTransferHistory()
    const prior = history.find(
      (r) => r.contentHash === hash && (r.status === 'interrupted' || r.status === 'paused')
    )
    // Track immediately so it survives renderer refresh even before first DownloadProgress
    activeDownloads.set(hash, {
      fileName,
      bytesTotal: 0,
      bytesDownloaded: 0,
      chunksReceived: 0,
      chunksTotal: 0,
      speedBps: 0,
      providers: 0,
      status: 'finding_providers',
      startedAt: prior?.startedAt ?? Date.now(),
      activeDurationMs: prior?.activeDurationMs ?? 0,
      sessionActiveStart: null,
      savePath
    })
    await node.startDownload(hash, fileName, savePath)
  })

  ipcMain.handle('transfers:pause', async (_event, hash: string) => {
    if (!node) throw new Error('Node not started')
    await node.pauseDownload(hash)
  })

  ipcMain.handle('transfers:resume', async (_event, hash: string) => {
    if (!node) throw new Error('Node not started')
    if (activeDownloads.has(hash)) {
      // Live paused download — resume in Rust
      await node.resumeDownload(hash)
    } else {
      // History record (after app restart) — restart download
      // BLAKE3 chunk verification will resume from temp file automatically
      const history = getTransferHistory()
      const record = history.find((r) => r.contentHash === hash)
      if (!record) throw new Error('Download not found')
      const resumeBaseDir = loadSettings().downloadFolder || join(app.getPath('downloads'), 'Nexus')
      const savePath = join(resumeBaseDir, record.fileName)
      activeDownloads.set(hash, {
        fileName: record.fileName,
        bytesTotal: record.bytesTotal,
        bytesDownloaded: record.bytesDownloaded ?? 0,
        chunksReceived: 0,
        chunksTotal: 0,
        speedBps: 0,
        providers: 0,
        status: 'finding_providers',
        startedAt: record.startedAt ?? Date.now(),
        activeDurationMs: record.activeDurationMs ?? 0,
        sessionActiveStart: null,
        savePath
      })
      removeTransferRecord(hash)
      await node.startDownload(hash, record.fileName, savePath)
    }
  })

  ipcMain.handle('transfers:cancel', async (_event, hash: string) => {
    if (!node) throw new Error('Node not started')
    await node.cancelDownload(hash)
    activeDownloads.delete(hash)
  })

  ipcMain.handle('transfers:getActive', async () => {
    const result: Array<{
      contentHash: string
      fileName: string
      status: string
      chunksReceived: number
      chunksTotal: number
      bytesDownloaded: number
      bytesTotal: number
      speedBps: number
      providers: number
      startedAt: number
      activeDurationMs: number
    }> = []
    for (const [hash, info] of activeDownloads) {
      result.push({
        contentHash: hash,
        fileName: info.fileName,
        status: info.status,
        chunksReceived: info.chunksReceived,
        chunksTotal: info.chunksTotal,
        bytesDownloaded: info.bytesDownloaded,
        bytesTotal: info.bytesTotal,
        speedBps: info.speedBps,
        providers: info.providers,
        startedAt: info.startedAt,
        activeDurationMs: info.sessionActiveStart !== null
          ? info.activeDurationMs + (Date.now() - info.sessionActiveStart)
          : info.activeDurationMs
      })
    }
    return result
  })

  ipcMain.handle('transfers:openFolder', async () => {
    const folder = loadSettings().downloadFolder || join(app.getPath('downloads'), 'Nexus')
    mkdirSync(folder, { recursive: true })
    await shell.openPath(folder)
  })

  ipcMain.handle('transfers:showInFolder', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('transfers:getHistory', async () => {
    return getTransferHistory().map((r) => ({
      ...r,
      fileExists: r.savePath ? existsSync(r.savePath) : undefined
    }))
  })

  ipcMain.handle('transfers:clearHistory', async () => {
    clearTransferHistory()
  })

  ipcMain.handle('transfers:removeHistory', async (_event, contentHash: string) => {
    removeTransferRecord(contentHash)
  })

  ipcMain.handle('p2p:addPeer', async (_event, multiaddr: string) => {
    if (!node) throw new Error('Node not started')
    await node.addPeer(multiaddr)
  })

  ipcMain.handle('p2p:getNatStatus', () => cachedNatStatus)

  ipcMain.handle('p2p:getExternalIp', () => cachedExternalIp)

  ipcMain.handle('p2p:getBootstrapStatus', () => cachedBootstrapConnected)

  ipcMain.handle('p2p:getRelayStatus', () => ({
    status: cachedRelayStatus,
    relayAddr: cachedRelayAddr
  }))
}

export function shutdownP2P(): void {
  // Save active downloads before stopping (synchronous to complete before quit)
  // Paused downloads keep 'paused' status so they don't auto-resume on next launch
  for (const [hash, info] of activeDownloads) {
    let activeDurationMs = info.activeDurationMs
    if (info.sessionActiveStart !== null) {
      activeDurationMs += Date.now() - info.sessionActiveStart
    }
    // Detect race condition: Rust completed the download (file renamed to final path)
    // but the DownloadComplete event didn't reach us before shutdown
    const alreadyComplete = info.savePath && existsSync(info.savePath)
    addTransferRecord({
      contentHash: hash,
      fileName: info.fileName,
      status: alreadyComplete ? 'complete' : info.status === 'paused' ? 'paused' : 'interrupted',
      bytesTotal: info.bytesTotal,
      bytesDownloaded: alreadyComplete ? info.bytesTotal : info.bytesDownloaded,
      savePath: info.savePath || undefined,
      completedAt: Date.now(),
      startedAt: info.startedAt,
      activeDurationMs
    })
  }
  activeDownloads.clear()

  if (node) {
    node.stop().catch(() => {})
    node = null
  }
}
