import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { sign } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupChat, shutdownChat, getIdentity, emitAvatarUpdated } from './chat'
import { setupP2P, shutdownP2P } from './p2p'
import { initSettings, loadSettings, saveSettings, AppSettings } from './settings'
import { initFileShare, setupFileShare } from './file-share'
import { initTransferStore } from './transfer-store'
import { setupUpdater } from './updater'
import { HUB_URL } from '../shared/config'

let mainWindow: BrowserWindow | null = null
let forceQuit = false

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    title: 'Nexus',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  // Hide instead of closing — keeps hub connection alive
  mainWindow.on('close', (event) => {
    if (!forceQuit) {
      event.preventDefault()
      mainWindow!.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nexus.app')

  const dataDir = process.env.NEXUS_DATA_DIR ?? app.getPath('userData')
  initSettings(join(dataDir, 'settings.json'))
  initFileShare(dataDir)
  initTransferStore(dataDir)

  ipcMain.handle('settings:load', async () => loadSettings())
  ipcMain.handle(
    'settings:save',
    async (_event, partial: Partial<AppSettings>) => saveSettings(partial)
  )
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('avatar:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Avatar',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const id = getIdentity()
    const fileBytes = readFileSync(result.filePaths[0])
    const timestamp = Date.now().toString()
    const signature = sign(null, Buffer.from(timestamp), id.privateKey).toString('hex')

    const formData = new FormData()
    formData.append('file', new Blob([fileBytes]), 'avatar.png')

    const resp = await fetch(`${HUB_URL}/api/avatar`, {
      method: 'POST',
      headers: {
        'X-Public-Key': id.publicKeyHex,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: formData
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Avatar upload failed: ${text}`)
    }

    const json = (await resp.json()) as { url: string }
    const avatarUrl = `${HUB_URL}${json.url}?t=${Date.now()}`
    saveSettings({ avatarPath: avatarUrl })
    emitAvatarUpdated(true)
    return avatarUrl
  })

  ipcMain.handle('avatar:remove', async () => {
    const id = getIdentity()
    const timestamp = Date.now().toString()
    const signature = sign(null, Buffer.from(timestamp), id.privateKey).toString('hex')

    await fetch(`${HUB_URL}/api/avatar`, {
      method: 'DELETE',
      headers: {
        'X-Public-Key': id.publicKeyHex,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      }
    })

    saveSettings({ avatarPath: '' })
    emitAvatarUpdated(false)
  })

  ipcMain.handle('pickDownloadFolder', async () => {
    if (!mainWindow) return null
    const current = loadSettings().downloadFolder
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Downloads Folder',
      defaultPath: current || join(app.getPath('downloads'), 'Nexus'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const window = createWindow()
  setupChat(window)
  setupFileShare(window)
  setupP2P(window)
  setupUpdater(window)

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('before-quit', () => {
  forceQuit = true
  shutdownChat()
  shutdownP2P()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
