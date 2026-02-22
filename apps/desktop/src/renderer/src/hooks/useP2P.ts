import { useContext } from 'react'
import { P2PContext, P2PContextValue } from '../context/P2PContext'

export function useP2P(): P2PContextValue {
  const ctx = useContext(P2PContext)
  if (!ctx) throw new Error('useP2P must be used within <P2PProvider>')
  return ctx
}
