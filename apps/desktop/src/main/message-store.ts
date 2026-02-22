import { createCipheriv, createDecipheriv, createHash, randomBytes, KeyObject } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'

interface StoredMessage {
  id: string
  sender: string
  nickname: string
  text: string
  timestamp: number
  failed?: boolean
}

export interface StoredConversation {
  messages: StoredMessage[]
  unread: number
  nickname: string
}

type DmStore = Record<string, StoredConversation>

let storePath = ''
let aesKey: Buffer | null = null
let cached: DmStore | null = null

/**
 * Initialize the encrypted message store.
 * Derives an AES-256 key from the Ed25519 private key.
 * Single file: {dataDir}/dm-history.enc — hides metadata about who you talked to.
 */
export function initMessageStore(dataDir: string, privateKey: KeyObject): void {
  storePath = join(dataDir, 'dm-history.enc')

  // Derive AES-256 key: SHA-256(raw private key bytes + domain separator)
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' })
  const raw = privDer.subarray(privDer.length - 32) // last 32 bytes = raw ed25519 key
  const hash = createHash('sha256')
  hash.update(raw)
  hash.update('nexus-dm-store')
  aesKey = hash.digest()
}

function encrypt(plaintext: string): Buffer {
  if (!aesKey) throw new Error('Message store not initialized')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: [12B IV][ciphertext][16B tag]
  return Buffer.concat([iv, encrypted, tag])
}

function decrypt(data: Buffer): string {
  if (!aesKey) throw new Error('Message store not initialized')
  const iv = data.subarray(0, 12)
  const tag = data.subarray(data.length - 16)
  const ciphertext = data.subarray(12, data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

function loadStore(): DmStore {
  if (cached) return cached
  try {
    if (!existsSync(storePath)) {
      cached = {}
      return cached
    }
    const data = readFileSync(storePath)
    const json = decrypt(data)
    const parsed = JSON.parse(json)
    // Migrate old format (plain message arrays) to new format
    cached = {}
    for (const [peerId, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        // Old format: just an array of messages
        cached[peerId] = { messages: value as StoredMessage[], unread: 0, nickname: '' }
      } else {
        cached[peerId] = value as StoredConversation
      }
    }
    return cached
  } catch {
    cached = {}
    return cached
  }
}

function saveStore(): void {
  if (!cached) return
  try {
    const dir = dirname(storePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const json = JSON.stringify(cached)
    const encrypted = encrypt(json)
    writeFileSync(storePath, encrypted)
  } catch {
    // Ignore write errors
  }
}

/**
 * Load DM conversation for a peer. Returns null if no history.
 */
export function loadDmConversation(peerId: string): StoredConversation | null {
  const store = loadStore()
  return store[peerId] ?? null
}

/**
 * Load all stored DM conversations (for restoring state on refresh).
 */
export function loadAllDmConversations(): Record<string, StoredConversation> {
  return { ...loadStore() }
}

/**
 * Save a DM conversation (updates in-memory cache and writes entire store encrypted).
 */
export function saveDmConversation(
  peerId: string,
  conversation: StoredConversation
): void {
  const store = loadStore()
  store[peerId] = conversation
  saveStore()
}
