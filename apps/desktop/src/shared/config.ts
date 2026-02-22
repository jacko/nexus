export const HUB_URL = import.meta.env.DEV
  ? 'http://127.0.0.1:4001'
  : 'https://voyt.dev:4001'

// Bootstrap peers for libp2p Kademlia + AutoNAT.
// The PeerId is stable across restarts (persisted identity).
// Replace <PEER_ID> with the actual value from the first bootstrap run.
export const BOOTSTRAP_PEERS: string[] = import.meta.env.DEV
  ? [
      '/ip4/127.0.0.1/tcp/4002/p2p/12D3KooW9pqr5oe2hhb7Sh1C7CPyZM6ax68asoYbijHeVWYJcxZS',
      '/ip4/127.0.0.1/udp/4002/quic-v1/p2p/12D3KooW9pqr5oe2hhb7Sh1C7CPyZM6ax68asoYbijHeVWYJcxZS',
    ]
  : [
      '/ip4/159.89.146.132/tcp/4003/p2p/12D3KooWNH2McgqQU5nJzthuBQa42GpuSsFh1z8Xrg9qDacT9Cvm',
      '/ip4/159.89.146.132/udp/4003/quic-v1/p2p/12D3KooWNH2McgqQU5nJzthuBQa42GpuSsFh1z8Xrg9qDacT9Cvm',
    ]
