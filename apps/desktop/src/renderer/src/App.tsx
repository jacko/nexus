import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import { useP2P } from './hooks/useP2P'
import type { FileListData, FileTreeNode } from './types/p2p'
import magnetIcon from './assets/magnet.png'
import { getNotesSinceVersion, type ReleaseNote } from './release-notes'
import { HUB_URL } from '../../shared/config'
import { setSoundEnabled, setSoundVolume, playNotificationSound, getAvatarCacheBust, bumpAvatarCacheBust } from './context/P2PContext'

const AVATAR_COLORS: Record<string, string> = {
  A: 'from-rose-400 to-orange-500',
  B: 'from-orange-400 to-amber-500',
  C: 'from-amber-400 to-yellow-500',
  D: 'from-yellow-400 to-lime-500',
  E: 'from-lime-400 to-green-500',
  F: 'from-green-400 to-emerald-500',
  G: 'from-emerald-400 to-teal-500',
  H: 'from-teal-400 to-cyan-500',
  I: 'from-cyan-400 to-sky-500',
  J: 'from-sky-400 to-blue-500',
  K: 'from-blue-400 to-indigo-500',
  L: 'from-indigo-400 to-violet-500',
  M: 'from-violet-400 to-purple-500',
  N: 'from-purple-400 to-fuchsia-500',
  O: 'from-fuchsia-400 to-pink-500',
  P: 'from-pink-400 to-rose-500',
  Q: 'from-rose-500 to-red-600',
  R: 'from-red-400 to-orange-600',
  S: 'from-orange-500 to-yellow-600',
  T: 'from-teal-500 to-emerald-600',
  U: 'from-blue-500 to-cyan-600',
  V: 'from-indigo-500 to-blue-600',
  W: 'from-violet-500 to-indigo-600',
  X: 'from-purple-500 to-violet-600',
  Y: 'from-fuchsia-500 to-purple-600',
  Z: 'from-pink-500 to-fuchsia-600'
}

function avatarGradient(name: string): string {
  const letter = (name[0] || '?').toUpperCase()
  return AVATAR_COLORS[letter] || 'from-slate-400 to-slate-500'
}

function LetterAvatar({ nickname, className }: { nickname: string; className?: string }): React.JSX.Element {
  return (
    <div className={`bg-gradient-to-br ${avatarGradient(nickname)} flex items-center justify-center font-bold text-white ${className || ''}`}>
      {nickname[0]?.toUpperCase()}
    </div>
  )
}

function UserAvatar({ userId, nickname, className, hasAvatar }: { userId: string; nickname: string; className?: string; hasAvatar?: boolean }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  // Reset failed state when avatar availability changes (e.g. user re-uploads)
  useEffect(() => { setFailed(false) }, [hasAvatar, userId])
  if (!hasAvatar || failed) {
    return <LetterAvatar nickname={nickname} className={className} />
  }
  return (
    <img
      src={`${HUB_URL}/avatars/${userId}_128.webp?v=${getAvatarCacheBust()}`}
      alt={nickname}
      className={`object-cover ${className || ''}`}
      onError={() => setFailed(true)}
    />
  )
}

function validateNickname(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length < 4) return i18n.t('validation.minLength')
  if (trimmed.length > 24) return i18n.t('validation.maxLength')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._\-]*[a-zA-Z0-9]$/.test(trimmed)) {
    return i18n.t('validation.startEnd')
  }
  if (/[_\-]{2,}/.test(trimmed)) return i18n.t('validation.noConsecutiveSpecial')
  if (/\s{2,}/.test(trimmed)) return i18n.t('validation.noConsecutiveSpaces')
  if (/[^a-zA-Z0-9 ._\-]/.test(trimmed)) {
    return i18n.t('validation.allowedChars')
  }
  return null
}

const App = (): React.JSX.Element => {
  const { t } = useTranslation()
  const { state, actions } = useP2P()
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('nexus:activeTab') ?? 'chat')
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [showUserPanel, setShowUserPanel] = useState(true)
  const [messageInput, setMessageInput] = useState('')
  const [openDmTabs, setOpenDmTabs] = useState<{ peerId: string; nickname: string }[]>(() => {
    try {
      const stored = localStorage.getItem('nexus:openDmTabs')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })
  const [showAvatarMenu, setShowAvatarMenu] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [memberFilter, setMemberFilter] = useState('')
  const [showMemberFilter, setShowMemberFilter] = useState(false)
  const [memberMenu, setMemberMenu] = useState<string | null>(null)
  const memberMenuRef = useRef<HTMLDivElement>(null)
  const avatarMenuRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const searchDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const memberFilterRef = useRef<HTMLInputElement>(null)

  // Resizable sidebar widths
  const [leftWidth, setLeftWidth] = useState(224)
  const [rightWidth, setRightWidth] = useState(256)
  const resizing = useRef<'left' | 'right' | null>(null)

  // Minimum loader display time (IPC resolves almost instantly, so enforce a visible spinner)
  const [minLoaderDone, setMinLoaderDone] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setMinLoaderDone(true), 600)
    return () => clearTimeout(timer)
  }, [])

  // Connection form state
  const [nicknameInput, setNicknameInput] = useState('')

  // Setup flow state
  const [setupStep, setSetupStep] = useState<'loading' | 'welcome' | 'mnemonic' | 'recovery' | 'returning'>('loading')
  const [mnemonicWords, setMnemonicWords] = useState<string[]>([])
  const [mnemonicRaw, setMnemonicRaw] = useState('')
  const [recoveryInput, setRecoveryInput] = useState('')
  const [recoveryError, setRecoveryError] = useState('')
  const [setupConnecting, setSetupConnecting] = useState(false)
  const [mnemonicCopied, setMnemonicCopied] = useState(false)

  // Settings page state
  const [soundOn, setSoundOn] = useState(true)
  const [volume, setVolume] = useState(1.0)
  const [avatarPath, setAvatarPath] = useState('')
  const [settingsNickname, setSettingsNickname] = useState('')
  const [nicknameSaved, setNicknameSaved] = useState(false)
  const [downloadFolder, setDownloadFolder] = useState('')
  const [language, setLanguage] = useState('en')

  // Sync settings nickname when switching to settings tab or when state.nickname changes
  useEffect(() => {
    if (activeTab === 'settings' && state.nickname) {
      setSettingsNickname(state.nickname)
    }
  }, [activeTab, state.nickname])

  // Auto-updater state
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'available' | 'downloading' | 'ready'>('idle')
  const [updateVersion, setUpdateVersion] = useState('')
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  // What's New modal state
  const [whatsNewNotes, setWhatsNewNotes] = useState<ReleaseNote[]>([])
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    const cleanup = window.api.onUpdaterEvent((event, data) => {
      const d = data as Record<string, unknown>
      switch (event) {
        case 'available':
          setUpdateStatus('available')
          setUpdateVersion((d.version as string) || '')
          setUpdateDismissed(false)
          break
        case 'progress':
          setUpdateStatus('downloading')
          setUpdateProgress((d.percent as number) || 0)
          break
        case 'downloaded':
          setUpdateStatus('ready')
          break
        case 'error':
          setUpdateStatus('idle')
          break
      }
    })
    return cleanup
  }, [])

  // Load settings + detect user type on mount
  useEffect(() => {
    window.api.loadSettings().then((settings) => {
      setLeftWidth(settings.leftSidebarWidth)
      setRightWidth(settings.rightSidebarWidth)
      setShowUserPanel(settings.showMemberList)
      setSoundOn(settings.soundEnabled)
      setSoundEnabled(settings.soundEnabled)
      setVolume(settings.soundVolume)
      setSoundVolume(settings.soundVolume)
      setAvatarPath(settings.avatarPath || '')
      setDownloadFolder(settings.downloadFolder || '')
      if (settings.language && settings.language !== i18n.language) {
        i18n.changeLanguage(settings.language)
        setLanguage(settings.language)
      }
    })
    Promise.all([
      window.api.hasIdentity(),
      window.api.getStoredNickname()
    ]).then(([hasId, storedNick]) => {
      if (hasId && storedNick) {
        setNicknameInput(storedNick)
        setSetupStep('returning')
      } else if (hasId) {
        setSetupStep('returning')
      } else {
        setSetupStep('welcome')
      }
    })
  }, [])

  // "What's New" — check on mount if version changed since last launch
  useEffect(() => {
    Promise.all([
      window.api.getAppVersion(),
      window.api.loadSettings()
    ]).then(([version, settings]) => {
      setAppVersion(version)
      const lastSeen = settings.lastSeenVersion || ''
      if (lastSeen !== version) {
        const notes = getNotesSinceVersion(lastSeen)
        if (notes.length > 0) {
          setWhatsNewNotes(notes)
          setShowWhatsNew(true)
        }
        window.api.saveSettings({ lastSeenVersion: version })
      }
    })
  }, [])

  // Auto-open tabs for DMs with unread messages that don't have a tab yet
  // Uses total message count as trigger so it fires even for existing conversations
  // (e.g. tab was closed but user sent another PM)
  const dmMsgCount = Array.from(state.dms.values()).reduce((s, dm) => s + dm.messages.length, 0)
  useEffect(() => {
    setOpenDmTabs((prev) => {
      const openPeerIds = new Set(prev.map((t) => t.peerId))
      const newTabs: { peerId: string; nickname: string }[] = []
      for (const [peerId, dm] of state.dms) {
        if (!openPeerIds.has(peerId) && dm.unread > 0) {
          newTabs.push({ peerId, nickname: dm.nickname })
        }
      }
      return newTabs.length > 0 ? [...prev, ...newTabs] : prev
    })
  }, [dmMsgCount])

  // Persist open DM tabs and active tab to localStorage
  useEffect(() => {
    localStorage.setItem('nexus:openDmTabs', JSON.stringify(openDmTabs))
  }, [openDmTabs])

  useEffect(() => {
    localStorage.setItem('nexus:activeTab', activeTab)
    if (activeTab === 'search') {
      setTimeout(() => searchInputRef.current?.focus(), 0)
    }
  }, [activeTab])

  // Persist a setting change
  const persistSettings = useCallback((partial: Partial<{ leftSidebarWidth: number; rightSidebarWidth: number; showMemberList: boolean }>) => {
    window.api.saveSettings(partial)
  }, [])

  // Resize drag handler — save widths on mouseup
  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (resizing.current === 'left') {
        setLeftWidth(Math.max(160, Math.min(400, e.clientX)))
      } else if (resizing.current === 'right') {
        setRightWidth(Math.max(160, Math.min(400, window.innerWidth - e.clientX)))
      }
    }
    const onMouseUp = (): void => {
      if (resizing.current === 'left') {
        const w = document.querySelector<HTMLElement>('[data-panel="left"]')
        if (w) persistSettings({ leftSidebarWidth: w.offsetWidth })
      } else if (resizing.current === 'right') {
        const w = document.querySelector<HTMLElement>('[data-panel="right"]')
        if (w) persistSettings({ rightSidebarWidth: w.offsetWidth })
      }
      resizing.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [persistSettings])

  // Active conversation data
  const activeRoomState = state.activeRoom ? state.rooms.get(state.activeRoom) : null
  // Track the DM currently being viewed (based on active tab, not state.activeDm)
  const viewedDmConvo = activeTab.startsWith('dm:') ? state.dms.get(activeTab.slice(3)) : null

  // Auto-scroll on new messages (rooms and DMs)
  // "restoring" = F5 reload, scroll instant. "ready" = normal use, scroll smooth.
  // handleConnect sets 'ready' immediately; timer covers F5 (no explicit Connect click).
  const scrollPhaseRef = useRef<'restoring' | 'ready'>('restoring')
  useEffect(() => {
    const timer = setTimeout(() => { scrollPhaseRef.current = 'ready' }, 2000)
    return () => clearTimeout(timer)
  }, [])
  const prevActiveTabRef = useRef(activeTab)
  const roomMsgCount = activeRoomState?.messages.length ?? 0
  const dmMsgCountView = viewedDmConvo?.messages.length ?? 0
  const currentMsgCount = activeTab === 'chat' ? roomMsgCount : dmMsgCountView
  useLayoutEffect(() => {
    const tabChanged = prevActiveTabRef.current !== activeTab
    prevActiveTabRef.current = activeTab
    const useInstant = tabChanged || scrollPhaseRef.current === 'restoring'
    messagesEndRef.current?.scrollIntoView({ behavior: useInstant ? 'instant' : 'smooth' })
  }, [activeTab, currentMsgCount, minLoaderDone])

  // Auto-focus the message input on tab switch, login, and app load
  useEffect(() => {
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [activeTab, minLoaderDone, state.connected])

  // Update window title with nickname
  useEffect(() => {
    document.title = state.nickname ? `Nexus — ${state.nickname}` : 'Nexus'
  }, [state.nickname])

  // Close avatar menu on outside click
  useEffect(() => {
    if (!showAvatarMenu) return
    const onClickOutside = (e: MouseEvent): void => {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target as Node)) {
        setShowAvatarMenu(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [showAvatarMenu])

  useEffect(() => {
    if (!memberMenu) return
    const onClickOutside = (e: MouseEvent): void => {
      if (memberMenuRef.current && !memberMenuRef.current.contains(e.target as Node)) {
        setMemberMenu(null)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [memberMenu])

  // Show error toasts
  const errCount = state.errors.length
  useEffect(() => {
    if (errCount === 0) return
    const msg = state.errors[errCount - 1]
    setToast(msg)
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [errCount])

  const handleConnect = async (): Promise<void> => {
    setSetupConnecting(true)
    try {
      scrollPhaseRef.current = 'ready' // user-initiated login → smooth scroll for incoming messages
      setActiveTab('chat')
      await actions.connect({ nickname: nicknameInput.trim() })
      // Auto-join lobby
      await actions.joinRoom('lobby')
    } catch {
      setSetupConnecting(false)
    }
  }

  const handleSendMessage = async (): Promise<void> => {
    if (!messageInput.trim() || !state.activeRoom) return
    const text = messageInput.trim()
    setMessageInput('')
    await actions.sendMessage(state.activeRoom, text)
  }

  const handleSendDmMessage = async (): Promise<void> => {
    const dmTarget = activeTab.startsWith('dm:') ? activeTab.slice(3) : null
    if (!messageInput.trim() || !dmTarget) return
    const text = messageInput.trim()
    setMessageInput('')
    await actions.sendDm(dmTarget, text)
  }

  const openDmTab = (peerId: string, nickname: string): void => {
    setOpenDmTabs((prev) => {
      if (prev.some((t) => t.peerId === peerId)) {
        // Update nickname if changed
        return prev.map((t) => (t.peerId === peerId ? { ...t, nickname } : t))
      }
      return [...prev, { peerId, nickname }]
    })
    actions.openDm(peerId, nickname)
    setActiveTab(`dm:${peerId}`)
    setMessageInput('')
  }

  const closeDmTab = (peerId: string): void => {
    setOpenDmTabs((prev) => prev.filter((t) => t.peerId !== peerId))
    if (activeTab === `dm:${peerId}`) {
      setActiveTab('chat')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent, handler: () => void): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.repeat) {
      e.preventDefault()
      handler()
    }
  }

  const emojiRegex = /(\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?)/gu

  const isEmojiOnly = (text: string): boolean => {
    const stripped = text.replace(/[\s\uFE0F]/g, '')
    return stripped.length > 0 && /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(stripped)
  }

  const renderMessage = (text: string): React.ReactNode => {
    if (isEmojiOnly(text)) {
      return <span className="text-3xl leading-snug">{text}</span>
    }
    const parts = text.split(emojiRegex)
    return parts.map((part, i) =>
      emojiRegex.test(part)
        ? <span key={i} className="text-xl align-middle">{part}</span>
        : part
    )
  }

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
  }

  const formatSpeed = (bytesPerSec: number): string => {
    const bits = bytesPerSec * 8
    if (bits < 1000) return `${bits.toFixed(0)} bps`
    if (bits < 1_000_000) return `${(bits / 1000).toFixed(1)} Kbps`
    if (bits < 1_000_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbps`
    return `${(bits / 1_000_000_000).toFixed(2)} Gbps`
  }

  const roomsList = Array.from(state.rooms.entries()).map(([id, room]) => ({
    id,
    name: room.name,
    users: room.members.size,
    unread: room.unread
  }))

  const activeMembers = activeRoomState
    ? Array.from(activeRoomState.members.entries()).map(([peerId, nickname]) => ({
        peerId,
        nickname,
        status: 'online' as const
      }))
    : []

  const filteredMembers = memberFilter
    ? activeMembers.filter((u) => {
        const q = memberFilter.trim().toLowerCase()
        return u.nickname.toLowerCase().includes(q) || u.peerId.toLowerCase().includes(q)
      })
    : activeMembers

  const StatusDot = ({ status }: { status: string }): React.JSX.Element => {
    const colors: Record<string, string> = {
      online: 'bg-emerald-400 shadow-emerald-400/50',
      away: 'bg-amber-400 shadow-amber-400/50',
      busy: 'bg-rose-400 shadow-rose-400/50'
    }
    return <div className={`w-2 h-2 rounded-full ${colors[status]} shadow-lg`} />
  }

  // ---- Loading screen (F5 / hard refresh) ----
  if (state.loading || !minLoaderDone) {
    return (
      <div className="h-screen bg-slate-950 text-slate-100 font-mono flex flex-col items-center justify-center grid-bg">
        <div className="w-16 h-16 relative animate-spin-slow">
          <div className="absolute inset-0 bg-cyan-500/20 rotate-45 rounded-sm" />
          <div className="absolute inset-2 bg-cyan-400/40 rotate-45 rounded-sm" />
          <div className="absolute inset-4 bg-cyan-300 rotate-45 rounded-sm" />
        </div>
        <span className="mt-6 text-slate-500 text-sm tracking-wider animate-pulse">{t('onboarding.reconnecting')}</span>
      </div>
    )
  }

  // ---- Setup / Connection screens ----
  if (!state.connected) {
    const nicknameError = nicknameInput.trim().length > 0 ? validateNickname(nicknameInput) : null
    const nicknameValid = nicknameInput.trim().length > 0 && nicknameError === null

    const handleGenerateMnemonic = async (): Promise<void> => {
      const mnemonic = await window.api.generateMnemonic()
      setMnemonicRaw(mnemonic)
      setMnemonicWords(mnemonic.split(' '))
      setMnemonicCopied(false)
      setSetupStep('mnemonic')
    }

    const handleFinishSetup = async (): Promise<void> => {
      setSetupConnecting(true)
      try {
        await window.api.createFromMnemonic(mnemonicRaw, nicknameInput.trim())
        scrollPhaseRef.current = 'ready'
        setActiveTab('chat')
        await actions.connect({ nickname: nicknameInput.trim() })
        await actions.joinRoom('lobby')
      } catch (err) {
        setSetupConnecting(false)
      }
    }

    const handleRecoverFromMnemonic = async (): Promise<void> => {
      const mnemonic = recoveryInput.trim().toLowerCase().replace(/\s+/g, ' ')
      const valid = await window.api.validateMnemonic(mnemonic)
      if (!valid) {
        setRecoveryError(i18n.t('onboarding.invalidPhrase'))
        return
      }
      setSetupConnecting(true)
      try {
        await window.api.createFromMnemonic(mnemonic, nicknameInput.trim())
        scrollPhaseRef.current = 'ready'
        setActiveTab('chat')
        await actions.connect({ nickname: nicknameInput.trim() })
        await actions.joinRoom('lobby')
      } catch (err) {
        setSetupConnecting(false)
      }
    }

    // Welcome step — new user enters name
    if (setupStep === 'welcome') {
      return (
        <div className="h-screen bg-slate-950 text-slate-100 font-mono flex items-center justify-center grid-bg">
          <div className="flex items-center gap-12">
            {/* Left — branding */}
            <div className="flex flex-col items-center gap-4">
              <img src={magnetIcon} alt="Nexus" className="w-20 h-20" />
              <span className="font-display font-bold text-4xl tracking-wider glow-cyan">NEXUS</span>
              <span className="text-slate-500 text-xs tracking-widest">DECENTRALIZED P2P</span>
            </div>

            {/* Neon separator */}
            <div className="w-px h-48 bg-gradient-to-b from-transparent via-cyan-500/60 to-transparent" />

            {/* Right — form */}
            <div className="space-y-6 w-[340px]">
              <div>
                <h1 className="text-3xl font-bold text-slate-100 mb-2">{t('welcome.heading')}</h1>
                <p className="text-slate-400 text-sm">{t('welcome.subtitle')}</p>
              </div>

              <div>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={nicknameInput}
                    onChange={(e) => setNicknameInput(e.target.value)}
                    placeholder={t('welcome.placeholder')}
                    maxLength={24}
                    className="flex-1 min-w-0 bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
                    onKeyDown={(e) => { if (e.key === 'Enter' && nicknameValid) handleGenerateMnemonic() }}
                    autoFocus
                  />
                  <button
                    onClick={handleGenerateMnemonic}
                    disabled={!nicknameValid}
                    className="px-6 py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-900 font-semibold rounded-lg transition-colors whitespace-nowrap"
                  >
                    Continue
                  </button>
                </div>
                {nicknameError && nicknameInput.trim().length > 0 && (
                  <p className="text-xs text-amber-400/70 mt-2">{nicknameError}</p>
                )}
              </div>

              <button
                onClick={() => setSetupStep('recovery')}
                className="text-xs text-slate-500 hover:text-cyan-400 transition-colors"
              >
                {t('onboarding.haveRecoveryPhrase')}
              </button>
            </div>
          </div>
        </div>
      )
    }

    // Mnemonic display step — show 12 words
    if (setupStep === 'mnemonic') {
      return (
        <div className="h-screen bg-slate-950 text-slate-100 font-mono flex flex-col items-center justify-center grid-bg relative">
          {/* Small inline logo top-left */}
          <div className="absolute top-6 left-6 flex items-center gap-2">
            <img src={magnetIcon} alt="Nexus" className="w-6 h-6" />
            <span className="font-display font-bold text-sm tracking-wider text-slate-400">NEXUS</span>
          </div>

          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-slate-100 mb-3">{t('onboarding.recoveryTitle')}</h1>
            <p className="text-slate-400 text-sm leading-relaxed">
              Save these 12 words in order. This is the only way to recover<br />
              your identity. Without it, you will lose access forever.
            </p>
          </div>

          <div className="w-[560px] grid grid-cols-4 gap-3 mb-4">
            {mnemonicWords.map((word, i) => (
              <div key={i} className="bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-3 text-center">
                <span className="text-[10px] text-slate-500 block mb-0.5">{i + 1}</span>
                <span className="text-sm text-slate-200">{word}</span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-6 mb-6">
            <button
              onClick={() => {
                navigator.clipboard.writeText(mnemonicRaw)
                setMnemonicCopied(true)
                setTimeout(() => setMnemonicCopied(false), 2000)
              }}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-400 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                {mnemonicCopied
                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  : <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>
                }
              </svg>
              {mnemonicCopied ? t('onboarding.copied') : t('onboarding.copy')}
            </button>
            <button
              onClick={handleGenerateMnemonic}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-400 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t('onboarding.refresh')}
            </button>
          </div>

          <p className="text-xs text-amber-400/80 text-center whitespace-nowrap mb-8">{t('onboarding.recoveryWarning')}</p>

          <div className="flex flex-col items-center gap-6">
            <button
              onClick={handleFinishSetup}
              disabled={setupConnecting}
              className="px-8 py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-900 font-semibold rounded-lg transition-colors"
            >
              {setupConnecting ? t('onboarding.connecting') : t('onboarding.savedPhrase')}
            </button>

            <button
              onClick={() => { setSetupStep('welcome'); setMnemonicWords([]); setMnemonicRaw('') }}
              className="text-xs text-slate-500 hover:text-cyan-400 transition-colors"
            >
              Back
            </button>
          </div>

          {state.errors.length > 0 && (
            <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-3 w-[560px]">
              {state.errors[state.errors.length - 1]}
            </div>
          )}
        </div>
      )
    }

    // Recovery step — enter existing mnemonic
    if (setupStep === 'recovery') {
      return (
        <div className="h-screen bg-slate-950 text-slate-100 font-mono flex flex-col items-center justify-center grid-bg">
          <div className="w-96 space-y-6">
            <div className="flex flex-col items-center gap-3 mb-4">
              <img src={magnetIcon} alt="Nexus" className="w-12 h-12" />
              <span className="font-display font-bold text-2xl tracking-wider glow-cyan">NEXUS</span>
            </div>

            <div className="text-center mb-2">
              <h1 className="text-xl font-bold text-slate-100 mb-2">{t('onboarding.recoverTitle')}</h1>
              <p className="text-slate-400 text-sm">{t('onboarding.recoverSubtitle')}</p>
            </div>

            <div className="bg-slate-900/80 border border-cyan-900/30 rounded-lg p-6 space-y-4 glow-box">
              <div>
                <label className="block text-xs font-semibold text-slate-400 tracking-wider mb-2">{t('onboarding.nameLabel')}</label>
                <input
                  type="text"
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  placeholder={t('welcome.placeholder')}
                  maxLength={24}
                  className="w-full bg-slate-800/50 border border-slate-700/50 rounded px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
                />
                {nicknameError && nicknameInput.trim().length > 0 && (
                  <p className="text-xs text-amber-400/70 mt-2">{nicknameError}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 tracking-wider mb-2">
                  {t('onboarding.phraseLabel')}
                </label>
                <textarea
                  value={recoveryInput}
                  onChange={(e) => { setRecoveryInput(e.target.value); setRecoveryError('') }}
                  placeholder={t('onboarding.phrasePlaceholder')}
                  rows={3}
                  className="w-full bg-slate-800/50 border border-slate-700/50 rounded px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 resize-none"
                />
              </div>

              {recoveryError && (
                <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-3">
                  {recoveryError}
                </div>
              )}

              <button
                onClick={handleRecoverFromMnemonic}
                disabled={!nicknameValid || !recoveryInput.trim() || setupConnecting}
                className="w-full px-4 py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-900 font-semibold rounded-lg transition-colors"
              >
                {setupConnecting ? t('onboarding.connecting') : t('onboarding.recoverConnect')}
              </button>
            </div>

            <button
              onClick={() => { setSetupStep('welcome'); setRecoveryError('') }}
              className="w-full text-center text-xs text-slate-500 hover:text-cyan-400 transition-colors"
            >
              Back to setup
            </button>
          </div>
        </div>
      )
    }

    // Returning user step — welcome back
    return (
      <div className="h-screen bg-slate-950 text-slate-100 font-mono flex items-center justify-center grid-bg">
        <div className="flex items-center gap-12">
          {/* Left — branding */}
          <div className="flex flex-col items-center gap-4">
            <img src={magnetIcon} alt="Nexus" className="w-20 h-20" />
            <span className="font-display font-bold text-4xl tracking-wider glow-cyan">NEXUS</span>
            <span className="text-slate-500 text-xs tracking-widest">DECENTRALIZED P2P</span>
          </div>

          {/* Neon separator */}
          <div className="w-px h-48 bg-gradient-to-b from-transparent via-cyan-500/60 to-transparent" />

          {/* Right — welcome back + connect */}
          <div className="space-y-6 w-[340px]">
            <div>
              <h1 className="text-3xl font-bold text-slate-100 mb-2">
                {t('onboarding.welcomeBack', { nickname: nicknameInput || t('welcome.heading') })}
              </h1>
              <span className="text-xs text-slate-600">{HUB_URL}</span>
            </div>

            <button
              onClick={handleConnect}
              disabled={setupConnecting}
              className="px-6 py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-900 font-semibold rounded-lg transition-colors"
            >
              {setupConnecting ? t('onboarding.connecting') : t('onboarding.connect')}
            </button>

            {state.errors.length > 0 && (
              <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-3">
                {state.errors[state.errors.length - 1]}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ---- Main app ----
  return (
    <div className="h-screen bg-slate-950 text-slate-100 font-mono flex flex-col">
      {/* Header */}
      <header className="h-14 border-b border-cyan-900/30 bg-slate-900/80 backdrop-blur-sm flex items-center px-4 gap-6 relative z-10">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <img src={magnetIcon} alt="Nexus" className="w-8 h-8" />
          <span className="font-display font-bold text-xl tracking-wider glow-cyan">NEXUS</span>
        </div>

        {/* Connection Status */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded">
          <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-emerald-400 text-xs font-medium">{t('header.connected')}</span>
        </div>

        {/* Network Stats */}
        <div className="flex items-center gap-6 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-cyan-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span className="text-slate-300">{t('header.peers', { count: state.peerCount })}</span>
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Peer ID (truncated) */}
        <div className="text-xs text-slate-500 font-mono">
          {state.myPeerId ? `${state.myPeerId.slice(0, 16)}...` : ''}
        </div>

        {/* User Menu */}
        <div ref={avatarMenuRef} className="relative flex items-center gap-3 pl-4 border-l border-slate-700/50">
          <div className="text-right">
            <div className="text-sm font-medium text-slate-200">{state.nickname}</div>
            <div className="text-xs text-slate-500">
              {t('header.peerConnected', { count: state.peerCount })}
            </div>
          </div>
          <button
            onClick={() => setShowAvatarMenu(!showAvatarMenu)}
            className="w-9 h-9 rounded overflow-hidden hover:opacity-90 transition-opacity cursor-pointer"
          >
            {avatarPath ? (
              <img src={avatarPath} className="w-full h-full object-cover" alt="avatar" />
            ) : (
              <div className={`w-full h-full bg-gradient-to-br ${avatarGradient(state.nickname || '')} flex items-center justify-center font-bold text-white`}>
                {state.nickname[0]?.toUpperCase()}
              </div>
            )}
          </button>

          {showAvatarMenu && (
            <div className="absolute right-0 top-12 w-56 bg-slate-800 border border-cyan-900/30 rounded-lg shadow-xl z-50 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-700/50">
                <div className="text-sm font-medium text-slate-200 truncate">{state.nickname}</div>
                <div className="text-xs text-slate-500 font-mono truncate">{state.myPeerId}</div>
              </div>
              <button
                onClick={() => {
                  setShowAvatarMenu(false)
                  setSettingsNickname(state.nickname)
                  setActiveTab('settings')
                }}
                className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700/50 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {t('header.settings')}
              </button>
              <button
                onClick={() => {
                  setShowAvatarMenu(false)
                  setActiveTab('blocked')
                }}
                className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700/50 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                {t('settings.blockedUsers')}
                {state.blockedUsers.size > 0 && (
                  <span className="ml-auto text-[10px] text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded">{state.blockedUsers.size}</span>
                )}
              </button>
              <button
                onClick={() => {
                  setShowAvatarMenu(false)
                  setSetupConnecting(false)
                  setSetupStep('returning')
                  actions.disconnect()
                }}
                className="w-full text-left px-4 py-2.5 text-sm text-rose-400 hover:bg-rose-500/10 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                {t('header.disconnect')}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Update Banner */}
      {updateStatus !== 'idle' && !updateDismissed && (
        <div className="px-4 py-2 bg-cyan-500/10 border-b border-cyan-500/20 flex items-center gap-3 text-sm">
          {updateStatus === 'available' && (
            <>
              <svg className="w-4 h-4 text-cyan-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span className="text-cyan-300">{t('update.available', { version: updateVersion })}</span>
              <button
                onClick={() => { setUpdateStatus('downloading'); window.api.downloadUpdate() }}
                className="px-3 py-1 bg-cyan-500 text-slate-900 text-xs font-semibold rounded hover:bg-cyan-400 transition-colors"
              >
                {t('update.download')}
              </button>
              <button
                onClick={() => setUpdateDismissed(true)}
                className="text-slate-500 hover:text-slate-300 ml-auto"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </>
          )}
          {updateStatus === 'downloading' && (
            <>
              <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              <span className="text-cyan-300">{t('update.downloading', { progress: updateProgress })}</span>
              <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden max-w-xs">
                <div className="h-full bg-cyan-400 rounded-full transition-all" style={{ width: `${updateProgress}%` }} />
              </div>
            </>
          )}
          {updateStatus === 'ready' && (
            <>
              <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-emerald-300">{t('update.ready')}</span>
              <button
                onClick={() => window.api.installUpdate()}
                className="px-3 py-1 bg-emerald-500 text-slate-900 text-xs font-semibold rounded hover:bg-emerald-400 transition-colors"
              >
                {t('update.restart')}
              </button>
              <button
                onClick={() => setUpdateDismissed(true)}
                className="text-slate-500 hover:text-slate-300 ml-auto"
              >
                {t('update.dismiss')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Rooms */}
        <aside data-panel="left" className="border-r border-cyan-900/30 bg-slate-900/50 flex flex-col flex-shrink-0" style={{ width: leftWidth }}>
          {/* Rooms Header */}
          <div className="p-3 border-b border-slate-800/50 relative">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-400 tracking-wider">{t('sidebar.rooms')}</span>
              <JoinRoomButton onJoin={actions.joinRoom} />
            </div>
          </div>

          {/* Room List */}
          <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
            {roomsList.map((room) => (
              <button
                key={room.id}
                onClick={() => actions.setActiveRoom(room.id)}
                className={`w-full text-left px-3 py-2.5 rounded transition-all ${
                  state.activeRoom === room.id
                    ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-300'
                    : 'hover:bg-slate-800/50 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium"># {room.name}</span>
                  {room.unread > 0 && (
                    <span className="px-1.5 py-0.5 text-xs bg-cyan-500 text-slate-900 rounded font-bold">
                      {room.unread}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">{t('members.membersCount', { count: room.users })}</div>
              </button>
            ))}
            {roomsList.length === 0 && (
              <div className="text-xs text-slate-500 px-3 py-4 text-center">
                {t('sidebar.noRooms')}
              </div>
            )}
          </div>

          {/* My Shares */}
          <div className="border-t border-slate-800/50 p-3">
            <div className="text-xs font-semibold text-slate-400 tracking-wider mb-3">{t('sidebar.myShares')}</div>
            <div className="space-y-1.5 text-xs max-h-32 overflow-y-auto scrollbar-thin">
              {state.sharedFolders.map((folder) => (
                <div key={folder.path} className="flex items-center justify-between text-slate-400 group">
                  <span className="truncate flex-1" title={folder.path}>
                    {folder.name}
                  </span>
                  <span className="text-slate-500 ml-2 flex-shrink-0">{formatSize(folder.totalSize)}</span>
                  <button
                    onClick={() => actions.removeSharedFolder(folder.path)}
                    className="ml-1 p-0.5 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition-all"
                    title="Remove"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              {state.sharedFolders.length === 0 && (
                <div className="text-slate-500 text-center py-1">{t('sidebar.noShares')}</div>
              )}
            </div>
            <button
              onClick={() => actions.addSharedFolder()}
              className="w-full mt-2 px-3 py-2 text-xs text-cyan-400 border border-cyan-500/30 rounded hover:bg-cyan-500/10 transition-colors"
            >
              + {t('sidebar.addFolder')}
            </button>
          </div>

        </aside>

        {/* Left resize handle */}
        <div
          className="w-1 cursor-col-resize hover:bg-cyan-500/30 active:bg-cyan-500/50 transition-colors flex-shrink-0"
          onMouseDown={() => {
            resizing.current = 'left'
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        />

        {/* Main Panel */}
        <main className="flex-1 flex flex-col overflow-hidden grid-bg">
          {/* Tabs */}
          <div className="flex items-center gap-1 px-4 pt-3 overflow-x-auto scrollbar-thin">
            {[
              { id: 'chat', label: t('tabs.chat') },
              { id: 'search', label: t('tabs.search') },
              { id: 'transfers', label: t('tabs.transfers') },
              { id: 'browse', label: t('tabs.browse') }
            ].map((tab) => {
              const activeTransferCount = tab.id === 'transfers'
                ? Array.from(state.transfers.values()).filter(
                    (t) => t.status !== 'complete' && t.status !== 'failed'
                  ).length + state.uploads.size
                : 0
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-2 text-sm font-medium rounded-t transition-all flex items-center gap-2 flex-shrink-0 ${
                    activeTab === tab.id
                      ? 'bg-slate-800/80 text-cyan-300 border-t border-x border-cyan-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
                  }`}
                >
                  <span>{tab.label}</span>
                  {activeTransferCount > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] bg-cyan-500 text-slate-900 rounded font-bold leading-none">
                      {activeTransferCount}
                    </span>
                  )}
                </button>
              )
            })}

            {/* Saved Messages tab (permanent, always first) */}
            {state.myPeerId && (() => {
              const savedDm = state.dms.get(state.myPeerId)
              const isSavedActive = activeTab === `dm:${state.myPeerId}`
              return (
                <div
                  className={`flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-t transition-all flex-shrink-0 cursor-pointer ${
                    isSavedActive
                      ? 'bg-slate-800/80 text-cyan-300 border-t border-x border-cyan-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
                  }`}
                  onClick={() => {
                    setActiveTab(`dm:${state.myPeerId}`)
                    actions.openDm(state.myPeerId!, 'Saved Messages')
                  }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                  <span>{t('tabs.saved')}</span>
                  {savedDm && savedDm.unread > 0 && !isSavedActive && (
                    <span className="px-1 py-0.5 text-[10px] bg-cyan-500 text-slate-900 rounded font-bold leading-none">
                      {savedDm.unread}
                    </span>
                  )}
                </div>
              )
            })()}

            {/* DM tabs */}
            {openDmTabs.filter((t) => t.peerId !== state.myPeerId).map(({ peerId, nickname: tabNickname }) => {
              const dm = state.dms.get(peerId)
              const nickname = dm?.nickname ?? tabNickname
              const isActive = activeTab === `dm:${peerId}`
              return (
                <div
                  key={`dm-${peerId}`}
                  className={`flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-t transition-all flex-shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-slate-800/80 text-purple-300 border-t border-x border-purple-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
                  }`}
                  onClick={() => {
                    setActiveTab(`dm:${peerId}`)
                    actions.openDm(peerId, nickname)
                  }}
                >
                  <span>{nickname}</span>
                  {dm && dm.unread > 0 && !isActive && (
                    <span className="px-1 py-0.5 text-[10px] bg-purple-500 text-white rounded font-bold leading-none">
                      {dm.unread}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeDmTab(peerId)
                    }}
                    className="ml-1 p-0.5 rounded hover:bg-slate-600/50 text-slate-500 hover:text-slate-200 transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>

          {/* Tab Content */}
          <div className="flex-1 bg-slate-800/40 border-t border-cyan-500/20 overflow-hidden flex">
            {/* DM conversation view */}
            {activeTab.startsWith('dm:') && (() => {
              const dmPeerId = activeTab.slice(3)
              const dmConvo = state.dms.get(dmPeerId)
              const isSavedMessages = dmPeerId === state.myPeerId
              const dmNickname = isSavedMessages ? t('chat.savedMessages') : (dmConvo?.nickname ?? dmPeerId.slice(0, 8))
              return (
                <div className="flex-1 flex flex-col">
                  {/* DM Header */}
                  <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {isSavedMessages ? (
                        <div className="w-8 h-8 rounded bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center">
                          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                          </svg>
                        </div>
                      ) : (
                        <UserAvatar userId={dmPeerId} nickname={dmNickname} className="w-8 h-8 rounded text-xs" hasAvatar={state.usersWithAvatar.has(dmPeerId)} />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="font-display font-semibold text-lg text-slate-100">
                            {dmNickname}
                          </h2>
                          {!isSavedMessages && state.blockedUsers.has(dmPeerId) && (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded">
                              {t('members.blocked')}
                            </span>
                          )}
                        </div>
                        {!isSavedMessages && (
                          <p className="text-xs text-slate-500 font-mono">
                            {dmPeerId.slice(0, 20)}...
                          </p>
                        )}
                      </div>
                    </div>
                    {!isSavedMessages && (
                      <div className="flex items-center gap-1">
                        <div className="relative" ref={memberMenu === `dm:${dmPeerId}` ? memberMenuRef : undefined}>
                          <button
                            onClick={() => setMemberMenu(memberMenu === `dm:${dmPeerId}` ? null : `dm:${dmPeerId}`)}
                            className="p-2 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-slate-200"
                          >
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                              <circle cx="12" cy="5" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="12" cy="19" r="2" />
                            </svg>
                          </button>
                          {memberMenu === `dm:${dmPeerId}` && (
                            <div className="absolute right-0 top-full mt-1 w-36 bg-slate-800 border border-slate-700/50 rounded-lg shadow-xl z-50 overflow-hidden">
                              <button
                                onClick={() => {
                                  const isBlocked = state.blockedUsers.has(dmPeerId)
                                  if (isBlocked) {
                                    actions.unblockUser(dmPeerId)
                                    setToast(t('toast.userUnblocked'))
                                  } else {
                                    actions.blockUser(dmPeerId)
                                    setToast(t('toast.userBlocked'))
                                  }
                                  setMemberMenu(null)
                                }}
                                className="w-full px-3 py-2 text-xs text-left text-rose-400 hover:bg-slate-700/50 transition-colors flex items-center gap-2"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                </svg>
                                {state.blockedUsers.has(dmPeerId) ? t('members.unblock') : t('members.block')}
                              </button>
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => closeDmTab(dmPeerId)}
                          className="p-2 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-slate-200"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* DM Message List */}
                  <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
                    {dmConvo?.messages.map((msg) => (
                      <div key={msg.id} className={`flex gap-3 ${msg.failed ? 'opacity-60' : ''}`}>
                        <UserAvatar userId={msg.sender} nickname={msg.nickname} className="w-8 h-8 rounded flex-shrink-0 text-xs" hasAvatar={state.usersWithAvatar.has(msg.sender)} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className={`font-medium text-sm ${
                              msg.sender === state.myPeerId ? 'text-cyan-300' : 'text-purple-300'
                            }`}>
                              {msg.sender === state.myPeerId ? state.nickname : msg.nickname}
                            </span>
                            <span className="text-xs text-slate-500">
                              {formatTime(msg.timestamp)}
                            </span>
                          </div>
                          <p className="text-sm text-slate-300 mt-0.5 whitespace-pre-wrap">{renderMessage(msg.text)}</p>
                          {msg.failed && (
                            <div className="flex items-center gap-1.5 mt-1 text-rose-400">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <span className="text-xs">{t('chat.notDelivered')}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {(!dmConvo || dmConvo.messages.length === 0) && (
                      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
                        {isSavedMessages
                          ? t('chat.savedDescription')
                          : t('chat.sayHello')}
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* DM Input */}
                  <div className="p-4 border-t border-slate-700/50">
                    <div className="flex items-end gap-3">
                      <textarea
                        ref={textareaRef}
                        rows={1}
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, handleSendDmMessage)}
                        placeholder={isSavedMessages ? t('chat.notePlaceholder') : t('chat.messagePlaceholder', { name: dmNickname })}
                        className="flex-1 bg-slate-900/50 border border-slate-700/50 rounded-lg px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 resize-none overflow-y-auto [field-sizing:content]"
                        style={{ maxHeight: '15rem' }}
                      />
                      <button
                        onClick={handleSendDmMessage}
                        className="p-3 bg-purple-500 hover:bg-purple-400 text-white rounded-lg transition-colors flex-shrink-0"
                      >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              )
            })()}

            {activeTab === 'chat' && (
              <>
                {/* Messages */}
                <div className="flex-1 flex flex-col">
                  {/* Room Header */}
                  <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
                    <div>
                      <h2 className="font-display font-semibold text-lg text-slate-100">
                        {state.activeRoom ? `# ${state.activeRoom}` : t('chat.noRoom')}
                      </h2>
                      <p className="text-xs text-slate-500">
                        {t('members.membersCount', { count: activeRoomState?.members.size ?? 0 })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          const next = !showUserPanel
                          setShowUserPanel(next)
                          persistSettings({ showMemberList: next })
                        }}
                        className="p-2 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-slate-200"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Message List */}
                  <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
                    {activeRoomState?.messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex gap-3 ${msg.system ? 'justify-center' : ''}`}
                      >
                        {msg.system ? (
                          <div className="text-xs text-slate-500 italic">{msg.text}</div>
                        ) : (
                          <>
                            <UserAvatar userId={msg.sender} nickname={msg.nickname} className="w-8 h-8 rounded flex-shrink-0 text-xs" hasAvatar={state.usersWithAvatar.has(msg.sender)} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2">
                                <span className="font-medium text-sm text-cyan-300 hover:underline cursor-pointer">
                                  {msg.nickname}
                                </span>
                                <span className="text-xs text-slate-500">
                                  {formatTime(msg.timestamp)}
                                </span>
                              </div>
                              <p className="text-sm text-slate-300 mt-0.5 whitespace-pre-wrap">{renderMessage(msg.text)}</p>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                    {(!activeRoomState || activeRoomState.messages.length === 0) && (
                      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
                        {state.activeRoom
                          ? t('chat.sayHello')
                          : t('chat.joinRoom')}
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Message Input */}
                  {state.activeRoom && (
                    <div className="p-4 border-t border-slate-700/50">
                      <div className="flex items-end gap-3">
                        <textarea
                          ref={textareaRef}
                          rows={1}
                          value={messageInput}
                          onChange={(e) => setMessageInput(e.target.value)}
                          onKeyDown={(e) => handleKeyDown(e, handleSendMessage)}
                          placeholder={t('chat.messagePlaceholder', { name: `#${state.activeRoom}` })}
                          className="flex-1 bg-slate-900/50 border border-slate-700/50 rounded-lg px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 resize-none overflow-y-auto [field-sizing:content]"
                          style={{ maxHeight: '15rem' }}
                        />
                        <button
                          onClick={handleSendMessage}
                          className="p-3 bg-cyan-500 hover:bg-cyan-400 text-slate-900 rounded-lg transition-colors flex-shrink-0"
                        >
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* User List Sidebar */}
                {showUserPanel && (
                  <>
                  {/* Right resize handle */}
                  <div
                    className="w-1 cursor-col-resize hover:bg-cyan-500/30 active:bg-cyan-500/50 transition-colors flex-shrink-0"
                    onMouseDown={() => {
                      resizing.current = 'right'
                      document.body.style.cursor = 'col-resize'
                      document.body.style.userSelect = 'none'
                    }}
                  />
                  <aside data-panel="right" className="border-l border-slate-700/50 flex flex-col flex-shrink-0" style={{ width: rightWidth }}>
                    <div className="p-3 border-b border-slate-700/50 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-400 tracking-wider">
                          {t('members.title')} ({activeMembers.length})
                        </span>
                        <button
                          onClick={() => {
                            setShowMemberFilter((v) => !v)
                            if (showMemberFilter) setMemberFilter('')
                            else setTimeout(() => memberFilterRef.current?.focus(), 0)
                          }}
                          className={`p-1 rounded transition-colors ${showMemberFilter ? 'text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                          </svg>
                        </button>
                      </div>
                      {showMemberFilter && (
                        <input
                          ref={memberFilterRef}
                          type="text"
                          value={memberFilter}
                          onChange={(e) => setMemberFilter(e.target.value)}
                          placeholder={t('members.search')}
                          className="w-full bg-slate-800/50 border border-slate-700/50 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
                        />
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
                      {filteredMembers.map((user) => {
                        const isSelf = user.peerId === state.myPeerId
                        return (
                          <button
                            key={user.peerId}
                            onClick={() =>
                              setSelectedUser(selectedUser === user.peerId ? null : user.peerId)
                            }
                            className={`w-full text-left px-3 py-2 rounded transition-all ${
                              selectedUser === user.peerId
                                ? 'bg-slate-700/50'
                                : 'hover:bg-slate-800/50'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <UserAvatar userId={user.peerId} nickname={user.nickname} className="w-6 h-6 rounded text-[10px]" hasAvatar={state.usersWithAvatar.has(user.peerId)} />
                              <StatusDot status={user.status} />
                              <span className={`text-sm font-medium truncate ${isSelf ? 'text-cyan-300' : 'text-slate-200'}`}>
                                {user.nickname}
                              </span>
                              {isSelf && (
                                <span className="text-[10px] text-slate-500">{t('members.you')}</span>
                              )}
                              {!isSelf && state.blockedUsers.has(user.peerId) && (
                                <svg className="w-3 h-3 text-rose-400/60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                </svg>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 mt-1 truncate font-mono">
                              {user.peerId.slice(0, 16)}...
                            </div>
                            {selectedUser === user.peerId && (
                              <div className="flex gap-2 mt-2 pt-2 border-t border-slate-700/50">
                                {!isSelf && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      actions.browseUser(user.peerId, user.nickname)
                                      setActiveTab('browse')
                                    }}
                                    className="flex-1 px-2 py-1 text-xs bg-cyan-500/10 text-cyan-400 rounded hover:bg-cyan-500/20 transition-colors"
                                  >
                                    {t('members.browse')}
                                  </button>
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (isSelf) {
                                      setActiveTab(`dm:${user.peerId}`)
                                      actions.openDm(user.peerId, 'Saved Messages')
                                      setMessageInput('')
                                    } else {
                                      openDmTab(user.peerId, user.nickname)
                                    }
                                  }}
                                  className="flex-1 px-2 py-1 text-xs bg-cyan-500/10 text-cyan-400 rounded hover:bg-cyan-500/20 transition-colors"
                                >
                                  {isSelf ? t('chat.savedMessages') : t('members.pm')}
                                </button>
                                {!isSelf && (
                                  <div className="relative" ref={memberMenu === user.peerId ? memberMenuRef : undefined}>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setMemberMenu(memberMenu === user.peerId ? null : user.peerId)
                                      }}
                                      className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 rounded hover:bg-slate-700/50 transition-colors"
                                    >
                                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                                        <circle cx="12" cy="5" r="2" />
                                        <circle cx="12" cy="12" r="2" />
                                        <circle cx="12" cy="19" r="2" />
                                      </svg>
                                    </button>
                                    {memberMenu === user.peerId && (
                                      <div className="absolute right-0 bottom-full mb-1 w-36 bg-slate-800 border border-slate-700/50 rounded-lg shadow-xl z-50 overflow-hidden">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            const isBlocked = state.blockedUsers.has(user.peerId)
                                            if (isBlocked) {
                                              actions.unblockUser(user.peerId)
                                              setToast(t('toast.userUnblocked'))
                                            } else {
                                              actions.blockUser(user.peerId)
                                              setToast(t('toast.userBlocked'))
                                            }
                                            setMemberMenu(null)
                                            setSelectedUser(null)
                                          }}
                                          className="w-full px-3 py-2 text-xs text-left text-rose-400 hover:bg-slate-700/50 transition-colors flex items-center gap-2"
                                        >
                                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                          </svg>
                                          {state.blockedUsers.has(user.peerId) ? t('members.unblock') : t('members.block')}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </button>
                        )
                      })}
                      {filteredMembers.length === 0 && (
                        <div className="text-xs text-slate-500 px-3 py-4 text-center">
                          {memberFilter ? t('members.noResults') : t('members.noMembers')}
                        </div>
                      )}
                    </div>
                  </aside>
                  </>
                )}
              </>
            )}

            {activeTab === 'search' && (() => {
              const searchDebounceRef = searchDebounceTimerRef
              return (
                <div className="flex-1 flex flex-col min-h-0">
                  {/* Search input */}
                  <div className="p-3 border-b border-slate-700/50">
                    <div className="relative">
                      <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      <input
                        ref={searchInputRef}
                        type="text"
                        autoFocus
                        placeholder={t('search.placeholder')}
                        className="w-full bg-slate-800 text-slate-200 text-sm rounded-lg pl-9 pr-8 py-2 border border-slate-700 focus:border-cyan-500 focus:outline-none placeholder-slate-500"
                        value={searchQuery}
                        onChange={(e) => {
                          const q = e.target.value
                          setSearchQuery(q)
                          if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
                          if (q.trim().length < 2) {
                            actions.clearSearch()
                            return
                          }
                          searchDebounceRef.current = setTimeout(() => {
                            actions.searchFiles(q.trim())
                          }, 300)
                        }}
                      />
                      {searchQuery && (
                        <button
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                          onClick={() => {
                            setSearchQuery('')
                            actions.clearSearch()
                          }}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Results */}
                  <div className="flex-1 overflow-y-auto scrollbar-thin">
                    {state.searchLoading && state.searchResults.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full text-slate-500">
                        <div className="animate-spin w-6 h-6 border-2 border-slate-600 border-t-cyan-400 rounded-full mb-3" />
                        <p className="text-sm">{t('search.searching')}</p>
                      </div>
                    )}

                    {!state.searchLoading && state.searchId && state.searchResults.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full text-slate-500">
                        <svg className="w-10 h-10 text-slate-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <p className="text-sm">{t('search.noResults')}</p>
                      </div>
                    )}

                    {!state.searchId && state.searchResults.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full text-slate-500">
                        <svg className="w-10 h-10 text-slate-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <p className="text-sm">{t('search.instructions')}</p>
                        <p className="text-xs text-slate-600 mt-1">{t('search.minChars')}</p>
                      </div>
                    )}

                    {state.searchResults.length > 0 && (
                      <div className="p-2">
                        <div className="text-xs text-slate-500 px-2 py-1 mb-1">
                          {state.searchResults.length} result{state.searchResults.length !== 1 ? 's' : ''}
                          {state.searchLoading && ' (searching...)'}
                        </div>
                        <div className="grid grid-cols-1 gap-0.5">
                          {state.searchResults.map((result, i) => (
                            <div
                              key={`${result.userId}-${result.filePath}-${i}`}
                              className="group flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-800/50 transition-colors"
                            >
                              <svg className={`w-5 h-5 flex-shrink-0 ${result.isFolder ? 'text-cyan-400' : 'text-slate-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                {result.isFolder ? (
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                ) : (
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                )}
                              </svg>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-slate-200 truncate">{result.fileName}</div>
                                <div className="text-xs text-slate-500 truncate">
                                  {formatSize(result.size)} &middot; from {result.nickname} &middot; {result.folderName}{result.filePath ? `/${result.filePath}` : ''}
                                </div>
                              </div>
                              {result.isFolder ? (
                                <button
                                  onClick={() => actions.browseUser(result.userId, result.nickname)}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded-md text-xs text-slate-400 hover:text-cyan-400 hover:bg-slate-700 flex-shrink-0"
                                  title={t('search.browseUser')}
                                >
                                  {t('members.browse')}
                                </button>
                              ) : result.contentHash ? (
                                <button
                                  onClick={() => actions.downloadFile(result.contentHash!, result.fileName)}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-slate-700 text-slate-400 hover:text-cyan-400 flex-shrink-0"
                                  title={t('search.downloadFile')}
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                  </svg>
                                </button>
                              ) : (
                                <button
                                  onClick={() => actions.browseUser(result.userId, result.nickname)}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded-md text-xs text-slate-400 hover:text-cyan-400 hover:bg-slate-700 flex-shrink-0"
                                  title={t('search.browseToDownload')}
                                >
                                  {t('members.browse')}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}

            {activeTab === 'transfers' && (() => {
              const transfers = Array.from(state.transfers.values())
              const uploads = Array.from(state.uploads.values())
              const activeTransfers = transfers.filter(
                (t) => t.status !== 'complete' && t.status !== 'failed'
              )
              const completedTransfers = transfers.filter(
                (t) => t.status === 'complete' || t.status === 'failed'
              )
              const totalSpeed = transfers.reduce(
                (sum, t) => sum + (t.status === 'downloading' ? t.speedBps : 0), 0
              )
              const totalUploadSpeed = uploads.reduce(
                (sum, u) => sum + u.speedBps, 0
              )

              return (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Downloads section header */}
                <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between bg-slate-900/30">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-slate-200">{t('transfers.downloads')}</span>
                    {activeTransfers.length > 0 && (
                      <span className="px-2 py-0.5 text-xs bg-emerald-500/10 text-emerald-400 rounded">
                        {t('transfers.activeCount', { count: activeTransfers.length })}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {totalSpeed > 0 && (
                      <div className="text-sm text-emerald-400">
                        <span className="text-slate-500 mr-1">&#8595;</span>
                        {formatSpeed(totalSpeed)}
                      </div>
                    )}
                    {completedTransfers.length > 0 && (
                      <button
                        onClick={() => {
                          if (confirm('Clear download history? Downloaded files will not be deleted.')) {
                            actions.clearTransferHistory()
                          }
                        }}
                        className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-rose-400"
                        title={t('transfers.clearHistory')}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => window.api.openDownloadsFolder()}
                      className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-cyan-400"
                      title={t('transfers.openFolder')}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Transfer list */}
                <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
                  {transfers.map((t) => {
                    const percent = t.chunksTotal > 0
                      ? Math.round((t.chunksReceived / t.chunksTotal) * 100)
                      : t.bytesTotal > 0
                        ? Math.round((t.bytesDownloaded / t.bytesTotal) * 100)
                        : 0
                    const isActive = t.status === 'downloading' || t.status === 'finding_providers' || t.status === 'requesting_metadata'
                    const chunkBlocks = Math.max(t.chunksTotal, 1)
                    // Cap visualization to 40 blocks
                    const vizBlocks = Math.min(chunkBlocks, 40)
                    const blocksPerViz = chunkBlocks / vizBlocks

                    // ETA calculation
                    let eta = ''
                    if (t.status === 'downloading' && t.speedBps > 0 && t.bytesTotal > 0) {
                      const remaining = t.bytesTotal - t.bytesDownloaded
                      const secs = Math.ceil(remaining / t.speedBps)
                      if (secs >= 3600) {
                        eta = `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
                      } else {
                        eta = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
                      }
                    }

                    return (
                      <div key={t.contentHash} className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/30 relative overflow-hidden corner-accent">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className={`text-2xl flex-shrink-0 ${t.status === 'complete' && t.fileExists === false ? 'opacity-40' : ''}`}>{
                              t.status === 'complete'
                                ? (t.fileExists === false ? '\uD83D\uDDD1\uFE0F' : '\u2705')
                                : t.status === 'failed' ? '\u274c'
                                : (t.status === 'interrupted' || t.status === 'paused') ? '\u23F8\uFE0F'
                                : '\uD83D\uDCE6'
                            }</span>
                            <div className="min-w-0">
                              <div className={`font-medium ${t.status === 'complete' && t.fileExists === false ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{t.fileName}</div>
                              <div className="text-xs text-slate-500 mt-0.5">{
                                [
                                  t.bytesTotal > 0 ? formatSize(t.bytesTotal) : null,
                                  t.providers > 0 ? i18n.t('transfers.source', { count: t.providers }) : null,
                                  eta ? `ETA: ${eta}` : null,
                                  t.status === 'complete' && t.fileExists === false ? i18n.t('transfers.fileRemoved') : null,
                                ].filter(Boolean).join(' \u2022 ')
                              }</div>
                              {t.error && <div className="text-xs text-rose-400 mt-0.5">{t.error}</div>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            {isActive && (
                              <button
                                onClick={() => actions.pauseDownload(t.contentHash)}
                                className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-slate-200"
                                title={i18n.t('transfers.pause')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                              </button>
                            )}
                            {t.status === 'paused' && (
                              <button
                                onClick={() => actions.resumeDownload(t.contentHash)}
                                className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-emerald-400"
                                title={i18n.t('transfers.resume')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                              </button>
                            )}
                            {isActive && (
                              <button
                                onClick={() => actions.cancelDownload(t.contentHash)}
                                className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-rose-400"
                                title={i18n.t('transfers.cancel')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            )}
                            {t.status === 'interrupted' && (
                              <button
                                onClick={() => actions.downloadFile(t.contentHash, t.fileName)}
                                className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-emerald-400"
                                title={i18n.t('transfers.retry')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            )}
                            {t.status === 'complete' && t.savePath && t.fileExists !== false && (
                              <button
                                onClick={() => window.api.showInFolder(t.savePath!)}
                                className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-cyan-400"
                                title={i18n.t('transfers.showInFolder')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
                                </svg>
                              </button>
                            )}
                            {(t.status === 'complete' || t.status === 'failed' || t.status === 'interrupted' || t.status === 'paused') && (
                              <button
                                onClick={() => actions.removeTransfer(t.contentHash)}
                                className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-slate-200"
                                title={i18n.t('transfers.remove')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Progress bar + percentage */}
                        {(t.status === 'downloading' || t.status === 'paused' || t.status === 'complete') && (
                          <div className="flex items-center gap-4">
                            <div className="flex-1">
                              <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${
                                    t.status === 'complete'
                                      ? 'bg-emerald-400'
                                      : t.status === 'paused'
                                        ? 'bg-amber-400/60'
                                        : 'bg-gradient-to-r from-cyan-500 to-emerald-400'
                                  }`}
                                  style={{ width: `${t.status === 'complete' ? 100 : percent}%` }}
                                />
                              </div>
                            </div>
                            <div className="text-sm font-mono flex-shrink-0">
                              <span className={t.status === 'paused' ? 'text-amber-400' : 'text-emerald-400'}>
                                {t.status === 'complete' ? '100' : percent}%
                              </span>
                              {t.status === 'paused' && (
                                <span className="text-amber-400 ml-2">{i18n.t('transfers.paused')}</span>
                              )}
                              {t.speedBps > 0 && t.status === 'downloading' && (
                                <span className="text-slate-500 ml-2">{formatSpeed(t.speedBps)}</span>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Finding peers / requesting metadata indicator */}
                        {(t.status === 'finding_providers' || t.status === 'requesting_metadata') && (
                          <div className="flex items-center gap-4">
                            {percent > 0 ? (
                              /* Resuming — show real progress with download color */
                              <div className="flex-1">
                                <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400"
                                    style={{ width: `${percent}%` }}
                                  />
                                </div>
                              </div>
                            ) : (
                              /* New download — yellow bar sliding across */
                              <div className="flex-1">
                                <div className="h-2 bg-slate-700/50 rounded-full scan-bar" />
                              </div>
                            )}
                            <div className="text-sm font-mono flex-shrink-0">
                              <span className="text-amber-400">
                                {percent > 0 ? `${percent}% \u2022 ` : ''}
                                {t.status === 'finding_providers' ? i18n.t('transfers.findingPeers') : i18n.t('transfers.gettingMetadata')}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Failed indicator */}
                        {t.status === 'failed' && (
                          <div className="flex items-center gap-2 text-xs text-rose-400">
                            <div className="flex-1 h-2 bg-slate-700/50 rounded-full overflow-hidden">
                              <div className="h-full bg-rose-500/40 rounded-full" style={{ width: `${percent}%` }} />
                            </div>
                            <span className="flex-shrink-0">{i18n.t('transfers.failed')}</span>
                          </div>
                        )}

                        {/* Interrupted indicator */}
                        {t.status === 'interrupted' && (
                          <div className="flex items-center gap-2 text-xs text-amber-400">
                            <div className="flex-1 h-2 bg-slate-700/50 rounded-full overflow-hidden">
                              <div className="h-full bg-amber-400/40 rounded-full" style={{ width: `${percent}%` }} />
                            </div>
                            <span className="flex-shrink-0">{i18n.t('transfers.interrupted')}</span>
                          </div>
                        )}

                        {/* Chunk visualization */}
                        {t.chunksTotal > 0 && (
                          <div className="flex gap-0.5 mt-3">
                            {Array.from({ length: vizBlocks }).map((_, i) => {
                              const chunkStart = Math.floor(i * blocksPerViz)
                              const chunkEnd = Math.floor((i + 1) * blocksPerViz)
                              // Check if any chunk in this range is received
                              let blockDone = true
                              for (let c = chunkStart; c < chunkEnd; c++) {
                                if (c >= t.chunksReceived) {
                                  blockDone = false
                                  break
                                }
                              }
                              // Check if block is "in progress" (just at the boundary)
                              const isEdge = !blockDone && chunkStart < t.chunksReceived + Math.ceil(blocksPerViz * 3)
                              return (
                                <div
                                  key={i}
                                  className={`h-1 flex-1 rounded-sm ${
                                    blockDone
                                      ? t.status === 'complete' ? 'bg-emerald-400' : 'bg-cyan-400'
                                      : isEdge && t.status === 'downloading'
                                        ? 'bg-amber-400 animate-pulse'
                                        : 'bg-slate-700'
                                  }`}
                                />
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {/* Uploads section */}
                  {uploads.length > 0 && (
                    <>
                      <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between bg-slate-900/30">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-slate-200">{t('transfers.uploads')}</span>
                          <span className="px-2 py-0.5 text-xs bg-cyan-500/10 text-cyan-400 rounded">
                            {uploads.length} active
                          </span>
                        </div>
                        {totalUploadSpeed > 0 && (
                          <div className="text-sm text-cyan-400">
                            <span className="text-slate-500 mr-1">&#8593;</span>
                            {formatSpeed(totalUploadSpeed)}
                          </div>
                        )}
                      </div>
                      {uploads.map((u) => {
                        const pct = u.bytesTotal > 0 ? Math.round((u.bytesSent / u.bytesTotal) * 100) : 0
                        return (
                          <div
                            key={`${u.peerId}:${u.contentHash}`}
                            className="px-4 py-3 border-b border-slate-700/30 hover:bg-slate-800/30 transition-colors"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-slate-200 truncate">{u.fileName}</div>
                                <div className="text-xs text-slate-500 mt-0.5">
                                  to {u.nickname} {u.speedBps > 0 ? `\u2022 ${formatSpeed(u.speedBps)}` : ''}
                                </div>
                              </div>
                              <div className="text-right flex-shrink-0 ml-2">
                                <div className="text-xs font-mono text-cyan-400">
                                  {formatSize(u.bytesSent)} / {formatSize(u.bytesTotal)}
                                </div>
                                <div className="text-[10px] text-slate-500 mt-0.5">
                                  {u.chunksServed}/{u.chunksTotal} chunks served
                                </div>
                              </div>
                            </div>
                            <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-cyan-400 rounded-full transition-all duration-300"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </>
                  )}

                  {state.transfers.size === 0 && uploads.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-slate-500">
                      <svg className="w-12 h-12 text-slate-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                      </svg>
                      <p className="text-sm">{t('transfers.noTransfers')}</p>
                      <p className="text-xs text-slate-600 mt-1">{t('transfers.noTransfersHint')}</p>
                    </div>
                  )}
                </div>
              </div>
              )
            })()}

            {activeTab === 'browse' && (
              <div className="flex-1 flex flex-col">
                {state.browseLoading && (
                  <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
                    <div className="w-12 h-12 relative animate-spin-slow mb-4">
                      <div className="absolute inset-0 bg-cyan-500/20 rotate-45 rounded-sm" />
                      <div className="absolute inset-2 bg-cyan-400/40 rotate-45 rounded-sm" />
                      <div className="absolute inset-4 bg-cyan-300 rotate-45 rounded-sm" />
                    </div>
                    <p className="text-sm">
                      {t('browse.loading', { name: state.browseTarget?.nickname ?? 'user' })}
                    </p>
                  </div>
                )}

                {!state.browseLoading && !state.browseData && (
                  <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
                    <svg className="w-12 h-12 text-slate-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <p className="text-sm">{t('browse.selectUser')}</p>
                    <p className="text-xs text-slate-600 mt-1">{t('browse.clickBrowse')}</p>
                  </div>
                )}

                {!state.browseLoading && state.browseData && (
                  <BrowseView
                    data={state.browseData}
                    onClose={() => actions.clearBrowse()}
                    formatSize={formatSize}
                    onDownloadFile={(hash, name, relativePath) => actions.downloadFile(hash, name, relativePath)}
                  />
                )}
              </div>
            )}
            {activeTab === 'settings' && (
              <div className="flex-1 overflow-y-auto p-6">
                <div className="flex items-center gap-3 mb-6">
                  <button
                    onClick={() => setActiveTab('chat')}
                    className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-slate-200"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <h2 className="text-xl font-semibold text-slate-100">{t('settings.title')}</h2>
                </div>
                <div className="max-w-lg mx-auto space-y-8">
                  {/* Profile Section */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">{t('settings.profile')}</h3>
                    <div className="bg-slate-800/50 rounded-lg p-5 space-y-5 border border-slate-700/50">
                      {/* Avatar */}
                      <div className="flex items-center gap-5">
                        <div className="w-20 h-20 rounded-lg overflow-hidden flex-shrink-0">
                          {avatarPath ? (
                            <img src={avatarPath} className="w-full h-full object-cover" alt="avatar" />
                          ) : (
                            <div className={`w-full h-full bg-gradient-to-br ${avatarGradient(state.nickname || '')} flex items-center justify-center font-bold text-white text-2xl`}>
                              {state.nickname[0]?.toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col gap-2">
                          <button
                            onClick={async () => {
                              const path = await window.api.pickAvatar()
                              if (path) {
                                bumpAvatarCacheBust()
                                setAvatarPath(path)
                              }
                            }}
                            className="px-4 py-1.5 text-sm text-cyan-400 border border-cyan-500/30 rounded hover:bg-cyan-500/10 transition-colors"
                          >
                            {t('settings.changeAvatar')}
                          </button>
                          {avatarPath && (
                            <button
                              onClick={async () => {
                                await window.api.removeAvatar()
                                bumpAvatarCacheBust()
                                setAvatarPath('')
                              }}
                              className="px-4 py-1.5 text-sm text-slate-400 border border-slate-600/50 rounded hover:bg-slate-700/50 transition-colors"
                            >
                              {t('settings.removeAvatar')}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Nickname */}
                      <div className="space-y-2">
                        <label className="text-sm text-slate-400">{t('settings.nickname')}</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={settingsNickname}
                            onChange={(e) => {
                              setSettingsNickname(e.target.value)
                              setNicknameSaved(false)
                            }}
                            className="flex-1 bg-slate-900/60 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
                            maxLength={24}
                          />
                          <button
                            onClick={async () => {
                              const err = validateNickname(settingsNickname)
                              if (err) return
                              await actions.setNickname(settingsNickname.trim())
                              setNicknameSaved(true)
                              setTimeout(() => setNicknameSaved(false), 2000)
                            }}
                            disabled={
                              settingsNickname.trim() === state.nickname ||
                              !!validateNickname(settingsNickname)
                            }
                            className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
                          >
                            {nicknameSaved ? t('settings.saved') : t('settings.save')}
                          </button>
                        </div>
                        {settingsNickname && validateNickname(settingsNickname) && (
                          <p className="text-xs text-rose-400">{validateNickname(settingsNickname)}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Notifications Section */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">{t('settings.notifications')}</h3>
                    <div className="bg-slate-800/50 rounded-lg p-5 space-y-5 border border-slate-700/50">
                      {/* Sound Toggle */}
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm text-slate-200">{t('settings.alertSound')}</div>
                          <div className="text-xs text-slate-500">{t('settings.alertDescription')}</div>
                        </div>
                        <button
                          onClick={() => {
                            const next = !soundOn
                            setSoundOn(next)
                            setSoundEnabled(next)
                            window.api.saveSettings({ soundEnabled: next })
                          }}
                          className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${soundOn ? 'bg-cyan-600' : 'bg-slate-600'}`}
                        >
                          <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${soundOn ? 'left-[1.375rem]' : 'left-0.5'}`} />
                        </button>
                      </div>

                      {/* Volume Slider */}
                      <div className={`space-y-2 ${!soundOn ? 'opacity-40 pointer-events-none' : ''}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-slate-300">{t('settings.volume')}</span>
                          <span className="text-xs text-slate-500">{Math.round(volume * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={volume}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            setVolume(v)
                            setSoundVolume(v)
                            window.api.saveSettings({ soundVolume: v })
                          }}
                          className="w-full accent-cyan-500 cursor-pointer"
                        />
                      </div>

                      {/* Test Button */}
                      <button
                        onClick={() => playNotificationSound()}
                        disabled={!soundOn}
                        className="px-4 py-1.5 text-sm text-slate-300 border border-slate-600/50 rounded hover:bg-slate-700/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {t('settings.testSound')}
                      </button>
                    </div>
                  </div>

                  {/* Downloads Section */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">{t('settings.downloadsSection')}</h3>
                    <div className="bg-slate-800/50 rounded-lg p-5 space-y-4 border border-slate-700/50">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-sm text-slate-200">{t('settings.downloadLocation')}</div>
                          <div className="text-xs text-slate-500 truncate" title={downloadFolder || '~/Downloads/Nexus'}>
                            {downloadFolder || '~/Downloads/Nexus'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {downloadFolder && (
                            <button
                              onClick={() => {
                                setDownloadFolder('')
                                window.api.saveSettings({ downloadFolder: '' })
                              }}
                              className="px-3 py-1.5 text-sm text-slate-400 border border-slate-600/50 rounded hover:bg-slate-700/50 transition-colors"
                            >
                              {t('settings.resetDefault')}
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              const folder = await window.api.pickDownloadFolder()
                              if (folder) {
                                setDownloadFolder(folder)
                                window.api.saveSettings({ downloadFolder: folder })
                              }
                            }}
                            className="px-3 py-1.5 text-sm text-cyan-400 border border-cyan-500/30 rounded hover:bg-cyan-500/10 transition-colors"
                          >
                            {t('settings.change')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Language Section */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">{t('settings.language')}</h3>
                    <div className="bg-slate-800/50 rounded-lg p-5 space-y-4 border border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm text-slate-200">{t('settings.language')}</div>
                          <div className="text-xs text-slate-500">{t('settings.languageDescription')}</div>
                        </div>
                        <select
                          value={language}
                          onChange={(e) => {
                            const lang = e.target.value
                            setLanguage(lang)
                            i18n.changeLanguage(lang)
                            window.api.saveSettings({ language: lang })
                          }}
                          className="bg-slate-900/60 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50 cursor-pointer"
                        >
                          <option value="en">English</option>
                          <option value="uk">Українська</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Network Section */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">{t('settings.network')}</h3>
                    <div className="bg-slate-800/50 rounded-lg p-5 space-y-4 border border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm text-slate-200">{t('settings.natStatus')}</div>
                          <div className="text-xs text-slate-500">{t('settings.natDescription')}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${
                            state.natStatus === 'public'
                              ? 'bg-emerald-400'
                              : state.natStatus === 'private'
                                ? 'bg-amber-400'
                                : 'bg-slate-500 animate-pulse'
                          }`} />
                          <span className={`text-sm font-medium ${
                            state.natStatus === 'public'
                              ? 'text-emerald-400'
                              : state.natStatus === 'private'
                                ? 'text-amber-400'
                                : 'text-slate-400'
                          }`}>
                            {state.natStatus === 'public'
                              ? t('settings.natDirect')
                              : state.natStatus === 'private'
                                ? state.relayStatus === 'reserved'
                                  ? t('settings.natRelayed')
                                  : t('settings.natBehind')
                                : t('settings.natChecking')}
                          </span>
                        </div>
                      </div>

                      {state.natStatus === 'private' && (
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm text-slate-200">{t('settings.relay')}</div>
                            <div className="text-xs text-slate-500">{t('settings.relayDescription')}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${
                              state.relayStatus === 'reserved'
                                ? 'bg-emerald-400'
                                : state.relayStatus === 'reserving'
                                  ? 'bg-amber-400 animate-pulse'
                                  : state.relayStatus === 'failed'
                                    ? 'bg-red-400'
                                    : 'bg-slate-500'
                            }`} />
                            <span className={`text-sm font-medium ${
                              state.relayStatus === 'reserved'
                                ? 'text-emerald-400'
                                : state.relayStatus === 'reserving'
                                  ? 'text-amber-400'
                                  : state.relayStatus === 'failed'
                                    ? 'text-red-400'
                                    : 'text-slate-400'
                            }`}>
                              {state.relayStatus === 'reserved'
                                ? t('settings.relayActive')
                                : state.relayStatus === 'reserving'
                                  ? t('settings.relayConnecting')
                                  : state.relayStatus === 'failed'
                                    ? t('settings.relayFailed')
                                    : t('settings.relayInactive')}
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm text-slate-200">{t('settings.discoveryServer')}</div>
                          <div className="text-xs text-slate-500">{t('settings.discoveryDescription')}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${
                            state.bootstrapConnected ? 'bg-emerald-400' : 'bg-red-400'
                          }`} />
                          <span className={`text-sm font-medium ${
                            state.bootstrapConnected ? 'text-emerald-400' : 'text-red-400'
                          }`}>
                            {state.bootstrapConnected ? t('settings.statusConnected') : t('settings.statusDisconnected')}
                          </span>
                        </div>
                      </div>

                      {state.externalIp && (
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm text-slate-200">{t('settings.externalIp')}</div>
                            <div className="text-xs text-slate-500">{t('settings.externalIpDescription')}</div>
                          </div>
                          <span className="text-sm text-slate-300 font-mono">{state.externalIp}</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm text-slate-200">{t('settings.connectedPeers')}</div>
                          <div className="text-xs text-slate-500">{t('settings.connectedPeersDescription')}</div>
                        </div>
                        <span className="text-sm text-slate-300">{state.peerCount}</span>
                      </div>

                      {state.myPeerId && (
                        <div>
                          <div className="text-sm text-slate-200 mb-1">{t('settings.peerId')}</div>
                          <div className="text-xs text-slate-500 font-mono break-all bg-slate-900/60 rounded px-3 py-2 border border-slate-700/50">
                            {state.myPeerId}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* App Info */}
                  <div className="text-xs text-slate-600 pt-4 border-t border-slate-800">
                    <div>Nexus {appVersion ? `v${appVersion}` : ''}</div>
                    <div className="mt-1">{HUB_URL}</div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'blocked' && (
              <div className="flex-1 overflow-y-auto p-6">
                <div className="flex items-center gap-3 mb-6">
                  <button
                    onClick={() => setActiveTab('chat')}
                    className="p-1.5 hover:bg-slate-700/50 rounded transition-colors text-slate-400 hover:text-slate-200"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <h2 className="text-xl font-semibold text-slate-100">{t('settings.blockedUsers')}</h2>
                  <div className="relative group">
                    <svg className="w-4 h-4 text-slate-500 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M12 18h.01" />
                      <circle cx="12" cy="12" r="10" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="absolute left-0 top-full mt-2 px-3 py-1.5 text-xs text-slate-300 bg-slate-700 border border-slate-600/50 rounded-lg shadow-xl w-max max-w-xs opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity">
                      {t('settings.blockedDescription')}
                    </div>
                  </div>
                </div>
                <div className="max-w-lg mx-auto space-y-6">
                  {state.blockedUsers.size === 0 ? (
                    <div className="text-sm text-slate-500 text-center py-8">{t('settings.noBlockedUsers')}</div>
                  ) : (
                    <div className="space-y-2">
                      {[...state.blockedUsers].map((userId) => {
                        const dmConvo = state.dms.get(userId)
                        let nickname = dmConvo?.nickname || userId.slice(0, 16) + '...'
                        for (const room of state.rooms.values()) {
                          const memberNick = room.members.get(userId)
                          if (memberNick) { nickname = memberNick; break }
                        }
                        return (
                          <div key={userId} className="flex items-center justify-between gap-3 bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <UserAvatar userId={userId} nickname={nickname} className="w-8 h-8 rounded text-xs flex-shrink-0" hasAvatar={state.usersWithAvatar.has(userId)} />
                              <div className="min-w-0">
                                <div className="text-sm text-slate-200 truncate">{nickname}</div>
                                <div className="text-[10px] text-slate-500 font-mono truncate">{userId.slice(0, 20)}...</div>
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                actions.unblockUser(userId)
                                setToast(t('toast.userUnblocked'))
                              }}
                              className="px-3 py-1.5 text-xs text-slate-400 border border-slate-600/50 rounded hover:bg-slate-700/50 transition-colors flex-shrink-0"
                            >
                              {t('members.unblock')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* What's New Modal */}
      {showWhatsNew && whatsNewNotes.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 border border-cyan-500/30 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="px-6 pt-5 pb-3 border-b border-slate-800/50">
              <h2 className="text-lg font-semibold text-cyan-300 flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
                {t('whatsNew.title', { version: '' }).replace(/\s*$/, '')}
              </h2>
            </div>
            <div className="px-6 py-4 max-h-80 overflow-y-auto space-y-4">
              {whatsNewNotes.map((note) => (
                <div key={note.version}>
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="text-sm font-semibold text-slate-200">v{note.version}</span>
                    <span className="text-xs text-slate-500">{note.date}</span>
                  </div>
                  <ul className="space-y-1.5">
                    {note.highlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                        <span className="text-cyan-400 mt-0.5 flex-shrink-0">&#8226;</span>
                        {h}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-slate-800/50 flex justify-end">
              <button
                onClick={() => setShowWhatsNew(false)}
                className="px-4 py-2 bg-cyan-500 text-slate-900 text-sm font-semibold rounded-lg hover:bg-cyan-400 transition-colors"
              >
                {t('whatsNew.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Error Toast */}
      {toast && (
        <div className="fixed bottom-10 right-4 z-50 max-w-sm px-4 py-2.5 bg-slate-900/95 border border-rose-500/40 rounded-lg shadow-xl flex items-center gap-3 backdrop-blur-sm">
          <svg className="w-4 h-4 text-rose-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm text-rose-300">{toast}</span>
          <button onClick={() => setToast(null)} className="text-rose-400 hover:text-rose-200 transition-colors ml-2">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Status Bar */}
      <footer className="h-7 bg-slate-900/80 border-t border-cyan-900/30 flex items-center px-4 text-xs text-slate-500 gap-6">
        <span>
          {t('footer.status')}{' '}
          <span className={state.connected ? 'text-emerald-400' : 'text-rose-400'}>
            {state.connected ? t('footer.connected') : t('footer.disconnected')}
          </span>
        </span>
        <span>
          {t('footer.peers')} <span className="text-slate-300">{state.peerCount}</span>
        </span>
        <span>
          {t('footer.rooms')} <span className="text-slate-300">{state.rooms.size}</span>
        </span>
        {state.errors.length > 0 && !state.indexingProgress && (
          <span className="text-rose-400 truncate max-w-xs">
            {state.errors[state.errors.length - 1]}
          </span>
        )}
        {state.indexingProgress && (
          <span className="flex items-center gap-2 text-cyan-400">
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>
              {t('footer.indexing', { scanned: state.indexingProgress.filesScanned, total: state.indexingProgress.filesTotal })}
            </span>
            <span className="text-slate-500 truncate max-w-[200px]">
              {state.indexingProgress.currentFile}
            </span>
          </span>
        )}
        <div className="flex-1" />
        <span className="text-slate-600">{appVersion ? `v${appVersion}` : ''}</span>
      </footer>
    </div>
  )
}

// Small component for the "+" join room button with a popover
function JoinRoomButton({
  onJoin
}: {
  onJoin: (room: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [roomName, setRoomName] = useState('')

  const handleJoin = (): void => {
    if (roomName.trim()) {
      onJoin(roomName.trim())
      setRoomName('')
      setOpen(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-5 h-5 rounded bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 flex items-center justify-center text-lg"
      >
        +
      </button>
    )
  }

  return (
    <div className="absolute left-2 right-2 top-12 bg-slate-800 border border-cyan-500/30 rounded-lg p-3 shadow-lg z-50">
      <input
        type="text"
        value={roomName}
        onChange={(e) => setRoomName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleJoin()
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder={t('chat.roomPlaceholder')}
        autoFocus
        className="w-full bg-slate-900/50 border border-slate-700/50 rounded px-3 py-2 text-xs placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 mb-2"
      />
      <div className="flex gap-2">
        <button
          onClick={handleJoin}
          className="flex-1 px-2 py-1.5 text-xs bg-cyan-500 text-slate-900 rounded font-medium"
        >
          {t('chat.join')}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200"
        >
          {t('chat.cancel')}
        </button>
      </div>
    </div>
  )
}

function collectDownloadableFiles(
  node: FileTreeNode,
  prefix = ''
): { contentHash: string; name: string; relativePath: string }[] {
  const result: { contentHash: string; name: string; relativePath: string }[] = []
  if (node.children) {
    for (const child of node.children) {
      const childPrefix = prefix ? `${prefix}/${child.name}` : child.name
      result.push(...collectDownloadableFiles(child, childPrefix))
    }
  } else if (node.contentHash) {
    result.push({ contentHash: node.contentHash, name: node.name, relativePath: prefix || node.name })
  }
  return result
}

function BrowseView({
  data,
  onClose,
  formatSize,
  onDownloadFile
}: {
  data: FileListData
  onClose: () => void
  formatSize: (bytes: number) => string
  onDownloadFile: (contentHash: string, fileName: string, relativePath?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [browsePath, setBrowsePath] = useState<string[]>([])

  let currentItems: FileTreeNode[] = []

  if (browsePath.length === 0) {
    // Root: show all shared folders
    currentItems = data.folders.map((f) => ({
      name: f.name,
      size: f.totalSize,
      children: f.tree.children
    }))
  } else {
    const folderName = browsePath[0]
    const folder = data.folders.find((f) => f.name === folderName)
    if (folder) {
      let node: FileTreeNode = folder.tree
      for (let i = 1; i < browsePath.length; i++) {
        const child = node.children?.find((c) => c.name === browsePath[i])
        if (child) node = child
        else break
      }
      currentItems = node.children ?? []
    }
  }

  const sorted = [...currentItems].sort((a, b) => {
    const aDir = !!a.children
    const bDir = !!b.children
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      {/* Breadcrumb */}
      <div className="px-4 py-3 border-b border-slate-700/50 flex items-center gap-2 text-sm">
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-200 p-1"
          title={t('browse.close')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          onClick={() => setBrowsePath([])}
          className="text-cyan-400 hover:underline cursor-pointer"
        >
          {data.nickname}
        </button>
        {browsePath.map((segment, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="text-slate-500">/</span>
            <button
              onClick={() => setBrowsePath(browsePath.slice(0, i + 1))}
              className={i === browsePath.length - 1 ? 'text-slate-300' : 'text-cyan-400 hover:underline cursor-pointer'}
            >
              {segment}
            </button>
          </span>
        ))}
        <span className="ml-auto text-xs text-slate-500">
          {sorted.length} items
        </span>
      </div>

      {/* File/Folder list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
        <div className="grid grid-cols-1 gap-1">
          {sorted.map((item) => {
            const isDir = !!item.children
            return (
              <div
                key={item.name}
                className={`group flex items-center gap-4 p-3 rounded-lg hover:bg-slate-800/50 transition-colors text-left w-full ${isDir ? 'cursor-pointer' : ''}`}
                onClick={() => {
                  if (isDir) setBrowsePath([...browsePath, item.name])
                }}
              >
                <svg className={`w-5 h-5 flex-shrink-0 ${isDir ? 'text-cyan-400' : 'text-slate-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {isDir ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  )}
                </svg>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-200 truncate">{item.name}</div>
                  <div className="text-xs text-slate-500">
                    {isDir ? `${item.children?.length ?? 0} items` : formatSize(item.size)}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (isDir) {
                      const files = collectDownloadableFiles(item)
                      for (const f of files) {
                        onDownloadFile(f.contentHash, f.name, `${item.name}/${f.relativePath}`)
                      }
                    } else if (item.contentHash) {
                      onDownloadFile(item.contentHash, item.name)
                    }
                  }}
                  disabled={!isDir && !item.contentHash}
                  className={`opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md flex-shrink-0 ${
                    !isDir && !item.contentHash
                      ? 'text-slate-600 cursor-not-allowed'
                      : 'hover:bg-slate-700 text-slate-400 hover:text-cyan-400'
                  }`}
                  title={!isDir && !item.contentHash ? t('browse.notIndexed') : isDir ? t('browse.downloadFolder') : t('browse.downloadFile')}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
              </div>
            )
          })}
          {sorted.length === 0 && (
            <div className="text-center text-slate-500 text-sm py-8">
              {browsePath.length === 0 ? t('browse.noFolders') : t('browse.emptyFolder')}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default App
