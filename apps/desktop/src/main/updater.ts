import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { writeFileSync, appendFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync, spawn } from 'child_process'

let logFile = ''
function log(msg: string): void {
  if (!logFile) logFile = join(app.getPath('userData'), 'updater.log')
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(logFile, line) } catch { /* */ }
}

// Store the downloaded zip path for manual macOS install
let downloadedFilePath = ''

export function setupUpdater(mainWindow: BrowserWindow): void {
  // In dev mode, load the dev-app-update.yml for local testing
  if (is.dev) {
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.autoDownload = false

  // On macOS, disable autoInstallOnAppQuit to prevent Squirrel.Mac from
  // running its native signature verification (fails for ad-hoc signed apps).
  // We handle macOS installs manually instead.
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin'

  logFile = join(app.getPath('userData'), 'updater.log')
  writeFileSync(logFile, `[${new Date().toISOString()}] Updater init, isDev=${is.dev}, platform=${process.platform}\n`)

  function sendToRenderer(event: string, data: unknown): void {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:event', event, data)
    }
  }

  autoUpdater.on('checking-for-update', () => {
    log('checking-for-update')
    sendToRenderer('checking', {})
  })

  autoUpdater.on('update-available', (info) => {
    log(`update-available: ${info.version}`)
    sendToRenderer('available', {
      version: info.version,
      releaseDate: info.releaseDate
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    log(`update-not-available: ${info.version}`)
    sendToRenderer('not-available', {})
  })

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    // Capture the downloaded file path for manual macOS install
    downloadedFilePath = (info as unknown as Record<string, unknown>).downloadedFile as string || ''
    log(`update-downloaded: ${info.version}, file: ${downloadedFilePath}`)
    sendToRenderer('downloaded', {
      version: info.version
    })
  })

  autoUpdater.on('error', (err) => {
    log(`error: ${err.message}`)
    sendToRenderer('error', { message: err.message })
  })

  // IPC handlers
  ipcMain.handle('updater:check', async () => {
    return autoUpdater.checkForUpdates()
  })

  ipcMain.handle('updater:download', async () => {
    return autoUpdater.downloadUpdate()
  })

  ipcMain.handle('updater:install', () => {
    if (process.platform === 'darwin') {
      manualMacInstall()
    } else {
      autoUpdater.quitAndInstall(false, true)
    }
  })

  // Check for updates on startup (after a short delay)
  setTimeout(() => {
    log('startup check starting...')
    autoUpdater.checkForUpdates().catch((err) => {
      log(`startup check error: ${err.message}`)
    })
  }, 3000)
}

/**
 * Manual macOS update installer.
 * Bypasses Squirrel.Mac/ShipIt which rejects ad-hoc signed apps.
 * Extracts the downloaded zip, removes quarantine, and replaces the running app.
 */
function manualMacInstall(): void {
  const zipPath = findDownloadedZip()
  if (!zipPath) {
    log('manualMacInstall: could not find downloaded zip')
    return
  }

  log(`manualMacInstall: using zip at ${zipPath}`)

  const appPath = process.execPath.replace(/\/Contents\/MacOS\/.*$/, '')
  const tmpDir = join(app.getPath('temp'), `nexus-update-${Date.now()}`)
  const extractedApp = join(tmpDir, 'Nexus.app')
  const pid = process.pid

  // Build a shell script that waits for the app to exit, then replaces it
  const script = `#!/bin/bash
# Wait for the current app process to exit
while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done
sleep 0.5

# Replace the app bundle
rm -rf "${appPath}"
mv "${extractedApp}" "${appPath}"

# Clear quarantine
xattr -cr "${appPath}" 2>/dev/null

# Clean up temp dir
rm -rf "${tmpDir}"

# Relaunch
open "${appPath}"
`

  try {
    // Extract the zip
    execSync(`mkdir -p "${tmpDir}"`)
    execSync(`ditto -xk "${zipPath}" "${tmpDir}"`)

    // Remove quarantine on extracted app
    execSync(`xattr -cr "${extractedApp}"`)

    log(`manualMacInstall: extracted to ${tmpDir}, launching update script`)

    // Write and run the replacement script
    const scriptPath = join(tmpDir, 'install-update.sh')
    writeFileSync(scriptPath, script, { mode: 0o755 })

    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()

    // Exit the app so the script can replace it
    app.exit(0)
  } catch (err) {
    log(`manualMacInstall error: ${(err as Error).message}`)
  }
}

/**
 * Find the downloaded update zip in electron-updater's cache directories.
 */
function findDownloadedZip(): string | null {
  // First: use the path captured from the update-downloaded event
  if (downloadedFilePath && existsSync(downloadedFilePath)) {
    return downloadedFilePath
  }

  // Fallback: search common cache directory locations
  const cacheBase = join(homedir(), 'Library', 'Caches')
  const names = [app.name, app.getName(), 'desktop', 'Nexus']
  const seen = new Set<string>()

  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)

    const updaterDir = join(cacheBase, `${name}-updater`)

    // Check for update.zip (cached copy)
    const cached = join(updaterDir, 'update.zip')
    if (existsSync(cached)) return cached

    // Check pending directory
    const pendingDir = join(updaterDir, 'pending')
    if (existsSync(pendingDir)) {
      try {
        const files = readdirSync(pendingDir)
        const zip = files.find((f) => f.endsWith('.zip'))
        if (zip) return join(pendingDir, zip)
      } catch { /* */ }
    }
  }

  return null
}
