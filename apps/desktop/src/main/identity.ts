import { generateKeyPairSync, createHash, createPublicKey, KeyObject } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic } from 'bip39'

export interface Identity {
  publicKeyHex: string
  privateKey: KeyObject
  userId: string
  identityPath: string
}

/**
 * Load or generate an Ed25519 keypair for user identity.
 * The keypair is persisted to disk so the user has the same identity across sessions.
 */
export function loadOrCreateIdentity(identityPath: string): Identity {
  let publicKey: KeyObject
  let privateKey: KeyObject

  if (existsSync(identityPath)) {
    // Load existing keypair
    const data = JSON.parse(readFileSync(identityPath, 'utf-8'))
    privateKey = createPrivateKeyFromRaw(Buffer.from(data.privateKey, 'hex'))
    publicKey = createPublicKeyFromRaw(Buffer.from(data.publicKey, 'hex'))
  } else {
    // Generate new keypair
    const pair = generateKeyPairSync('ed25519')
    publicKey = pair.publicKey
    privateKey = pair.privateKey

    // Persist to disk
    const dir = dirname(identityPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const pubRaw = publicKey.export({ type: 'spki', format: 'der' })
    const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' })

    writeFileSync(
      identityPath,
      JSON.stringify({
        publicKey: pubRaw.toString('hex'),
        privateKey: privRaw.toString('hex')
      }),
      'utf-8'
    )
  }

  // Extract raw 32-byte public key from DER-encoded SPKI
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const rawPubKey = pubDer.subarray(pubDer.length - 32) // last 32 bytes are the raw key

  const publicKeyHex = rawPubKey.toString('hex')

  // Derive userId = first 16 hex chars of SHA-256(publicKey)
  const hash = createHash('sha256').update(rawPubKey).digest('hex')
  const userId = hash.substring(0, 16)

  return { publicKeyHex, privateKey, userId, identityPath }
}

/**
 * Read the stored nickname from the identity file, if any.
 */
export function getStoredNickname(identityPath: string): string | null {
  try {
    if (!existsSync(identityPath)) return null
    const data = JSON.parse(readFileSync(identityPath, 'utf-8'))
    return data.nickname ?? null
  } catch {
    return null
  }
}

/**
 * Save the nickname to the identity file alongside the keypair.
 */
export function saveNickname(identityPath: string, nickname: string): void {
  try {
    const data = JSON.parse(readFileSync(identityPath, 'utf-8'))
    data.nickname = nickname
    writeFileSync(identityPath, JSON.stringify(data), 'utf-8')
  } catch {
    // Ignore — identity file might not exist yet
  }
}

function createPrivateKeyFromRaw(derBytes: Buffer): KeyObject {
  const { createPrivateKey } = require('crypto')
  return createPrivateKey({ key: derBytes, format: 'der', type: 'pkcs8' })
}

function createPublicKeyFromRaw(derBytes: Buffer): KeyObject {
  const { createPublicKey } = require('crypto')
  return createPublicKey({ key: derBytes, format: 'der', type: 'spki' })
}

/**
 * Check if identity file exists.
 */
export function hasIdentity(identityPath: string): boolean {
  return existsSync(identityPath)
}

/**
 * Generate a 12-word BIP-39 mnemonic.
 */
export { validateMnemonic }
export function generateMnemonic(): string {
  return bip39Generate(128) // 128 bits = 12 words
}

/**
 * Create identity files from a BIP-39 mnemonic.
 * Writes both identity.json (hub auth) and identity.key (libp2p).
 */
export function createIdentityFromMnemonic(
  mnemonic: string,
  nickname: string,
  identityJsonPath: string,
  identityKeyPath: string
): Identity {
  const seed = mnemonicToSeedSync(mnemonic)
  const ed25519Seed = seed.subarray(0, 32)
  return createIdentityFromSeed(Buffer.from(ed25519Seed), nickname, identityJsonPath, identityKeyPath)
}

/**
 * Create identity from a raw 32-byte Ed25519 seed.
 * Builds DER-encoded PKCS8 private key, derives public key,
 * writes identity.json + identity.key.
 */
function createIdentityFromSeed(
  seed: Buffer,
  nickname: string,
  identityJsonPath: string,
  identityKeyPath: string
): Identity {
  // Build PKCS8 DER for Ed25519: 16-byte header + 32-byte seed
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex')
  const pkcs8Der = Buffer.concat([pkcs8Header, seed])
  const privateKey = createPrivateKeyFromRaw(pkcs8Der)
  const publicKey = createPublicKey(privateKey)

  const pubDer = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))
  const privDer = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }))

  // Ensure directories exist
  for (const p of [identityJsonPath, identityKeyPath]) {
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  // Write identity.json (hub auth — DER hex encoded)
  writeFileSync(
    identityJsonPath,
    JSON.stringify({
      publicKey: pubDer.toString('hex'),
      privateKey: privDer.toString('hex'),
      nickname
    }),
    'utf-8'
  )

  // Write identity.key (libp2p — raw 32-byte Ed25519 secret)
  writeFileSync(identityKeyPath, seed)

  // Compute publicKeyHex and userId
  const rawPubKey = pubDer.subarray(pubDer.length - 32)
  const publicKeyHex = rawPubKey.toString('hex')
  const hash = createHash('sha256').update(rawPubKey).digest('hex')
  const userId = hash.substring(0, 16)

  return { publicKeyHex, privateKey, userId, identityPath: identityJsonPath }
}

/**
 * Sign a challenge nonce with the private key.
 * Returns the signature as a hex string.
 */
export function signChallenge(privateKey: KeyObject, nonceHex: string): string {
  const { sign } = require('crypto')
  const nonce = Buffer.from(nonceHex, 'hex')
  const signature = sign(null, nonce, privateKey)
  return signature.toString('hex')
}
