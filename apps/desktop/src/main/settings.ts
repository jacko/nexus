import { readFileSync, writeFileSync } from 'fs'
import { existsSync } from 'fs'

export interface AppSettings {
  leftSidebarWidth: number
  rightSidebarWidth: number
  showMemberList: boolean
  lastSeenVersion: string
  soundEnabled: boolean
  soundVolume: number
  avatarPath: string
  downloadFolder: string
  language: string
  blockedUsers: string[]
}

const defaults: AppSettings = {
  leftSidebarWidth: 224,
  rightSidebarWidth: 256,
  showMemberList: true,
  lastSeenVersion: '',
  soundEnabled: true,
  soundVolume: 0.25,
  avatarPath: '',
  downloadFolder: '',
  language: 'en',
  blockedUsers: []
}

let settingsPath = ''
let cached: AppSettings | null = null

export function initSettings(path: string): void {
  settingsPath = path
}

export function loadSettings(): AppSettings {
  if (cached) return cached

  if (!settingsPath || !existsSync(settingsPath)) {
    cached = { ...defaults }
    return cached
  }

  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    cached = { ...defaults, ...raw }
    return cached!
  } catch {
    cached = { ...defaults }
    return cached
  }
}

export function saveSettings(partial: Partial<AppSettings>): void {
  const current = loadSettings()
  cached = { ...current, ...partial }
  if (!settingsPath) return

  try {
    writeFileSync(settingsPath, JSON.stringify(cached, null, 2), 'utf-8')
  } catch {
    // Ignore write errors
  }
}
