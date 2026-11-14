import { expect, it, vi } from 'vitest'
import { createMistVaultTransport } from '../transport.js'
import type { MistNodeLike } from '../transport.js'
import { createSharedNodeScope } from '@tik-choco/mistai'

it('receives vault events through an existing mistai shared scope', async () => {
  let emit!: (type: number, from: string, data: unknown, room?: string) => void
  const real: MistNodeLike = {
    init: async () => {}, onEvent: cb => { emit = cb },
    joinRoom: async () => {}, leaveRoom: vi.fn(), sendMessage: vi.fn(),
  }
  const scope = createSharedNodeScope(() => real)
  const other = scope('same-peer'); await other.init(); await other.joinRoom('other')
  const transport = createMistVaultTransport({ createNode: () => scope('same-peer'),
    storageAdd: async () => 'cid', storageGet: async () => new Uint8Array(),
  })
  const received = vi.fn(), off = transport.onMessage('vault', received)
  try {
    await transport.join('vault')
    emit(0, 'provider', Uint8Array.of(1), 'other')
    expect(received).not.toHaveBeenCalled()
    emit(0, 'provider', Uint8Array.of(2), 'vault')
    expect(received).toHaveBeenCalledExactlyOnceWith('provider', Uint8Array.of(2))
  } finally { off(); transport.leave('vault'); other.leaveRoom('other') }
})

it('isolates simultaneous rooms on separate handles and releases only the requested room', async () => {
  let emit!: (type: number, from: string, data: unknown, room?: string) => void
  const real: MistNodeLike = {
    init: async () => {}, onEvent: cb => { emit = cb },
    joinRoom: vi.fn(async () => {}), leaveRoom: vi.fn(), sendMessage: vi.fn(),
  }
  const scope = createSharedNodeScope(() => real), createNode = vi.fn(() => scope('same-peer'))
  const transport = createMistVaultTransport({ createNode, storageAdd: async () => 'cid', storageGet: async () => new Uint8Array() })
  const first = vi.fn(), second = vi.fn()
  transport.onMessage('first', first); transport.onMessage('second', second)
  try {
    await Promise.all([transport.join('first'), transport.join('second'), transport.join('first')])
    expect(createNode).toHaveBeenCalledTimes(2)
    emit(0, 'peer', Uint8Array.of(1), 'first')
    expect(first).toHaveBeenCalledExactlyOnceWith('peer', Uint8Array.of(1)); expect(second).not.toHaveBeenCalled()
    transport.send('second', 'peer', Uint8Array.of(2))
    expect(real.sendMessage).toHaveBeenCalledExactlyOnceWith('peer', Uint8Array.of(2), 0, 'second')
    transport.leave('first'); expect(real.leaveRoom).not.toHaveBeenCalled()
    transport.leave('first'); expect(real.leaveRoom).toHaveBeenCalledExactlyOnceWith('first')
    emit(0, 'peer', Uint8Array.of(3), 'second')
    expect(second).toHaveBeenCalledExactlyOnceWith('peer', Uint8Array.of(3))
  } finally { transport.leave('first'); transport.leave('first'); transport.leave('second') }
})
