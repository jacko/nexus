import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export interface TransferRecord {
  contentHash: string
  fileName: string
  status: 'complete' | 'failed' | 'interrupted' | 'paused'
  bytesTotal: number
  bytesDownloaded?: number
  savePath?: string
  error?: string
  completedAt: number
  startedAt?: number
  activeDurationMs?: number
}

let storePath = ''
let cached: TransferRecord[] | null = null

export function initTransferStore(dataDir: string): void {
  storePath = `${dataDir}/transfer-history.json`
}

function load(): TransferRecord[] {
  if (cached) return cached
  try {
    if (!existsSync(storePath)) {
      cached = []
      return cached
    }
    cached = JSON.parse(readFileSync(storePath, 'utf-8'))
    if (!Array.isArray(cached)) cached = []
    return cached!
  } catch {
    cached = []
    return cached
  }
}

function save(): void {
  if (!cached) return
  try {
    const dir = dirname(storePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(storePath, JSON.stringify(cached, null, 2))
  } catch {
    // Ignore write errors
  }
}

export function addTransferRecord(record: TransferRecord): void {
  const records = load()
  // Replace if same hash already exists (re-download)
  const idx = records.findIndex((r) => r.contentHash === record.contentHash)
  if (idx >= 0) {
    records[idx] = record
  } else {
    records.push(record)
  }
  save()
}

export function getTransferHistory(): TransferRecord[] {
  return [...load()]
}

export function clearTransferHistory(): void {
  cached = []
  save()
}

export function removeTransferRecord(contentHash: string): void {
  const records = load()
  cached = records.filter((r) => r.contentHash !== contentHash)
  save()
}
