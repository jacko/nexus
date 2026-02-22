import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readdirSync, readFileSync, writeFileSync, existsSync, lstatSync } from 'fs'
import { join, basename, dirname } from 'path'
import { mkdirSync } from 'fs'
import { getIndexedFiles, indexFolderIfRunning } from './p2p'

// --- Types ---

interface SharedFolderConfig {
  path: string
}

interface FileTreeNode {
  name: string
  size: number
  contentHash?: string
  children?: FileTreeNode[]
}

interface SharedFolderInfo {
  path: string
  name: string
  totalSize: number
  fileCount: number
}

// --- Module state (same pattern as settings.ts) ---

let configPath = ''
let cachedFolders: SharedFolderConfig[] | null = null

// --- Init ---

export function initFileShare(dataDir: string): void {
  configPath = join(dataDir, 'shared-folders.json')
}

// --- Persistence ---

function loadConfig(): SharedFolderConfig[] {
  if (cachedFolders) return cachedFolders
  if (!configPath || !existsSync(configPath)) {
    cachedFolders = []
    return cachedFolders
  }
  try {
    cachedFolders = JSON.parse(readFileSync(configPath, 'utf-8'))
    return cachedFolders!
  } catch {
    cachedFolders = []
    return cachedFolders
  }
}

function saveConfig(): void {
  if (!configPath || !cachedFolders) return
  try {
    const dir = dirname(configPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(configPath, JSON.stringify(cachedFolders, null, 2), 'utf-8')
  } catch {
    // Ignore write errors
  }
}

// --- Folder scanning ---

function scanTree(dirPath: string, depth: number): FileTreeNode {
  const name = basename(dirPath)
  const node: FileTreeNode = { name, size: 0, children: [] }

  if (depth <= 0) return node

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return node
  }

  for (const entry of entries) {
    // Skip hidden files/folders
    if (entry.startsWith('.')) continue

    const fullPath = join(dirPath, entry)
    try {
      const stat = lstatSync(fullPath)
      // Skip symlinks to avoid loops
      if (stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        const child = scanTree(fullPath, depth - 1)
        node.children!.push(child)
        node.size += child.size
      } else if (stat.isFile()) {
        node.children!.push({ name: entry, size: stat.size })
        node.size += stat.size
      }
    } catch {
      // Skip entries we can't stat (permission errors, etc.)
    }
  }

  return node
}

function countFiles(node: FileTreeNode): number {
  if (!node.children) return 1
  let count = 0
  for (const child of node.children) {
    count += countFiles(child)
  }
  return count
}

function scanFolderInfo(folderPath: string): SharedFolderInfo {
  const tree = scanTree(folderPath, 10)
  return {
    path: folderPath,
    name: basename(folderPath),
    totalSize: tree.size,
    fileCount: countFiles(tree)
  }
}

// --- Content hash injection ---

function injectContentHashes(
  tree: FileTreeNode,
  hashByRelPath: Map<string, string>,
  prefix: string
): void {
  if (!tree.children) return
  for (const child of tree.children) {
    const relPath = prefix ? `${prefix}/${child.name}` : child.name
    if (child.children) {
      injectContentHashes(child, hashByRelPath, relPath)
    } else {
      const hash = hashByRelPath.get(relPath)
      if (hash) {
        child.contentHash = hash
      }
    }
  }
}

// --- Public API ---

export function getSharedFolders(): SharedFolderInfo[] {
  const folders = loadConfig()
  return folders
    .filter((f) => existsSync(f.path))
    .map((f) => scanFolderInfo(f.path))
}

export function getSharedFolderPaths(): string[] {
  return loadConfig().filter((f) => existsSync(f.path)).map((f) => f.path)
}

export function getFileListForRemote(
  nickname: string,
  userId: string
): {
  userId: string
  nickname: string
  folders: { name: string; totalSize: number; fileCount: number; tree: FileTreeNode }[]
} {
  const folders = loadConfig()
  const indexedFiles = getIndexedFiles()

  return {
    userId,
    nickname,
    folders: folders
      .filter((f) => existsSync(f.path))
      .map((f) => {
        const tree = scanTree(f.path, 10)

        // Build a relativePath → contentHash map for this folder
        const filesForFolder = indexedFiles.get(f.path)
        if (filesForFolder) {
          const hashByRelPath = new Map<string, string>()
          for (const file of filesForFolder) {
            hashByRelPath.set(file.relativePath, file.contentHash)
          }
          injectContentHashes(tree, hashByRelPath, '')
        }

        return {
          name: basename(f.path),
          totalSize: tree.size,
          fileCount: countFiles(tree),
          tree
        }
      })
  }
}

// --- Search ---

interface SearchResult {
  userId: string
  nickname: string
  fileName: string
  filePath: string
  size: number
  contentHash?: string
  folderName: string
  isFolder?: boolean
}

function searchNode(
  node: FileTreeNode,
  query: string,
  currentPath: string,
  folderName: string,
  userId: string,
  nickname: string,
  results: SearchResult[]
): void {
  const nameLower = node.name.toLowerCase()
  if (currentPath !== '' && nameLower.includes(query)) {
    if (node.children) {
      // Folder match
      results.push({
        userId,
        nickname,
        fileName: node.name,
        filePath: currentPath,
        size: node.size,
        folderName,
        isFolder: true
      })
    } else {
      // File match
      results.push({
        userId,
        nickname,
        fileName: node.name,
        filePath: currentPath,
        size: node.size,
        contentHash: node.contentHash,
        folderName
      })
    }
  }
  if (node.children) {
    for (const child of node.children) {
      const childPath = currentPath ? `${currentPath}/${child.name}` : child.name
      searchNode(child, query, childPath, folderName, userId, nickname, results)
    }
  }
}

export function searchSharedFiles(
  query: string,
  nickname: string,
  userId: string
): SearchResult[] {
  const q = query.toLowerCase()
  const results: SearchResult[] = []
  const folders = loadConfig()
  const indexedFiles = getIndexedFiles()

  for (const f of folders) {
    if (!existsSync(f.path)) continue
    const tree = scanTree(f.path, 10)
    const folderName = basename(f.path)

    const filesForFolder = indexedFiles.get(f.path)
    if (filesForFolder) {
      const hashByRelPath = new Map<string, string>()
      for (const file of filesForFolder) {
        hashByRelPath.set(file.relativePath, file.contentHash)
      }
      injectContentHashes(tree, hashByRelPath, '')
    }

    searchNode(tree, q, '', folderName, userId, nickname, results)
  }
  return results
}

// --- IPC setup ---

export function setupFileShare(mainWindow: BrowserWindow): void {
  ipcMain.handle('shares:addFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const folderPath = result.filePaths[0]
    const folders = loadConfig()
    if (folders.some((f) => f.path === folderPath)) return getSharedFolders()

    folders.push({ path: folderPath })
    cachedFolders = folders
    saveConfig()

    // Trigger indexing so content hashes become available
    indexFolderIfRunning(folderPath).catch((err) => {
      console.error('[file-share] Failed to index folder:', err)
    })

    return getSharedFolders()
  })

  ipcMain.handle('shares:removeFolder', async (_event, folderPath: string) => {
    const folders = loadConfig()
    cachedFolders = folders.filter((f) => f.path !== folderPath)
    saveConfig()
    return getSharedFolders()
  })

  ipcMain.handle('shares:getShared', async () => {
    return getSharedFolders()
  })

  ipcMain.handle('shares:rescan', async () => {
    cachedFolders = null
    return getSharedFolders()
  })
}
