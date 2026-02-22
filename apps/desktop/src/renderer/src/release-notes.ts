export interface ReleaseNote {
  version: string
  date: string
  highlights: string[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '1.7.0',
    date: '2026-02-13',
    highlights: [
      'Internationalization — full Ukrainian and English language support',
      'Auto-detect system language on first launch',
      'Proper Ukrainian pluralization (one/few/many forms)',
      'Telegram-style send button icon in chat'
    ]
  },
  {
    version: '1.6.0',
    date: '2026-02-10',
    highlights: [
      'File Search — find files and folders across all online peers in real-time',
      'Search results show download button for files and browse button for folders',
      'Auto-focus search input when switching to the Search tab'
    ]
  },
  {
    version: '1.5.0',
    date: '2026-02-10',
    highlights: [
      'Folder downloads now preserve subfolder structure instead of saving files flat',
      'Configurable download location in Settings (defaults to ~/Downloads/Nexus/)',
      'Open Downloads folder button now opens the configured location'
    ]
  },
  {
    version: '1.4.0',
    date: '2026-02-10',
    highlights: [
      'QUIC transport — faster connections and better NAT traversal via UDP',
      'Circuit Relay v2 — peers behind NAT can now be reached through the bootstrap node',
      'DCUtR hole punching — automatic direct connections between NATted peers',
      'Improved P2P reliability with libp2p best-practices audit fixes'
    ]
  },
  {
    version: '1.3.2',
    date: '2026-02-09',
    highlights: [
      'Discovery Server status — see if you are connected to the discovery node',
      'External IP display — your public address as seen by other peers',
      'Fixed External IP detection for users behind NAT'
    ]
  },
  {
    version: '1.3.0',
    date: '2026-02-09',
    highlights: [
      'P2P bootstrap node — peer discovery now works across networks',
      'AutoNAT detection — Settings page shows your NAT reachability status',
      'Network info section on Settings page (NAT status, peers, Peer ID)'
    ]
  },
  {
    version: '1.2.3',
    date: '2026-02-08',
    highlights: ['Removed tray icon — app now hides to dock on close']
  },
  {
    version: '1.2.2',
    date: '2026-02-08',
    highlights: ['Fixed avatars not showing in chat history for offline users']
  },
  {
    version: '1.2.1',
    date: '2026-02-08',
    highlights: [
      'Fixed avatars disappearing for other users',
      'Fixed re-uploaded avatars not updating on other clients',
      'Improved avatar state reliability across reconnections'
    ]
  },
  {
    version: '1.2.0',
    date: '2026-02-08',
    highlights: [
      'New Settings page — change your nickname anytime',
      'Avatar uploads — set a profile picture visible to everyone',
      'Message sound controls — toggle notifications and adjust volume'
    ]
  },
  {
    version: '1.1.1',
    date: '2026-02-08',
    highlights: [
      'Added "What\'s New" popup after updates',
      'Improved auto-update reliability',
      'Fixed update server compatibility issues'
    ]
  },
  {
    version: '1.1.0',
    date: '2026-02-08',
    highlights: [
      'Auto-update support — get new versions without re-downloading',
      'Mnemonic-based identity with backup & recovery',
      'Nickname validation and avatar colors',
      'Resizable sidebar panels',
      'DM conversation persistence',
      'Tray icon with hide-to-tray on close'
    ]
  }
]

export function getNotesForVersion(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((n) => n.version === version)
}

export function getNotesSinceVersion(lastSeen: string): ReleaseNote[] {
  const idx = RELEASE_NOTES.findIndex((n) => n.version === lastSeen)
  if (idx === -1) return RELEASE_NOTES // never seen → show all
  return RELEASE_NOTES.slice(0, idx) // everything newer than lastSeen
}
