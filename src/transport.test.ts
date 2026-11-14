import { expect, it, vi } from 'vitest'
import { createMistVaultTransport } from './transport.js'
import type { MistNodeLike } from './transport.js'

function setup() {
  const callbacks = new Set<(event: number, from: string, payload: unknown, room?: string) => void>()
  const node: MistNodeLike = { init: vi.fn(async () => {}), onEvent: cb => { callbacks.add(cb) },
    joinRoom: vi.fn(), joinRoomAsync: vi.fn(async () => {}), leaveRoom: vi.fn(), sendMessage: vi.fn() }
  const options = { createNode: vi.fn(() => node), storageAdd: vi.fn(async () => 'cid'), storageGet: vi.fn(async () => Uint8Array.of(1)) }
  return { node, options, transport: createMistVaultTransport(options), emit: (event: number, data: unknown, room = 'vault') => { for (const cb of callbacks) cb(event, 'peer', data, room) } }
}
it('creates no node until joining and reference-counts its own rooms', async () => {
  const { node, options, transport } = setup()
  transport.leave('other'); expect(options.createNode).not.toHaveBeenCalled()
  await Promise.all([transport.join('vault'), transport.join('vault')])
  expect(node.joinRoomAsync).toHaveBeenCalledExactlyOnceWith('vault')
  transport.send('vault', 'p', Uint8Array.of(1))
  expect(node.sendMessage).toHaveBeenCalledWith('p', Uint8Array.of(1), 0, 'vault')
  transport.leave('other'); transport.leave('vault'); expect(node.leaveRoom).not.toHaveBeenCalled()
  transport.leave('vault'); expect(node.leaveRoom).toHaveBeenCalledExactlyOnceWith('vault')
})
it('copies queued messages, bounds the queue and message size, and routes room events', async () => {
  const { node, transport, emit } = setup()
  let release!: () => void
  vi.mocked(node.joinRoomAsync!).mockImplementation(() => new Promise(resolve => { release = resolve }))
  const message = vi.fn(), peer = vi.fn(), off = transport.onMessage('vault', message)
  transport.onPeer('vault', peer)
  const joining = transport.join('vault'), bytes = Uint8Array.of(7)
  transport.send('vault', null, bytes); bytes[0] = 9
  for (let i = 1; i < 64; i++) transport.send('vault', null, Uint8Array.of(i))
  expect(() => transport.send('vault', null, bytes)).toThrow('queue full')
  expect(() => transport.send('vault', null, new Uint8Array(16385))).toThrow('limit')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  emit(0, [2, 3]); emit(2, null); emit(3, null); emit(0, [4], 'other'); emit(0, new Uint8Array(16385)); emit(0, [-1])
  expect(message).toHaveBeenCalledExactlyOnceWith('peer', Uint8Array.of(2, 3))
  expect(peer.mock.calls).toEqual([['peer', true], ['peer', false]])
  release(); await joining
  expect(node.sendMessage).toHaveBeenNthCalledWith(1, null, Uint8Array.of(7), 0, 'vault')
  off(); emit(0, [5]); expect(message).toHaveBeenCalledTimes(1)
  transport.leave('vault')
})
it('shares downloads by CID across handles and evicts settled requests', async () => {
  const { options, transport } = setup()
  let finish!: (bytes: Uint8Array) => void
  options.storageGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const second = createMistVaultTransport(options), first = transport.storageGet(' cid ')
  expect(second.storageGet('cid')).toBe(first)
  await Promise.resolve(); finish(Uint8Array.of(3)); expect(await first).toEqual(Uint8Array.of(3))
  await transport.storageGet('cid'); expect(options.storageGet).toHaveBeenCalledTimes(2)
  options.storageGet.mockRejectedValueOnce(new Error('Missing'))
  await expect(transport.storageGet('bad')).rejects.toThrow('Missing')
  await transport.storageGet('bad'); expect(options.createNode).not.toHaveBeenCalled()
})
it('drops sends after leave, releases late joins, and reacquires an in-flight join', async () => {
  const { transport, node } = setup()
  let release!: () => void
  vi.mocked(node.joinRoomAsync!).mockImplementation(() => new Promise(resolve => { release = resolve }))
  const first = transport.join('vault')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  transport.send('vault', null, Uint8Array.of(1)); transport.leave('vault')
  const second = transport.join('vault'); release(); await Promise.all([first, second])
  expect(node.sendMessage).not.toHaveBeenCalled(); expect(node.leaveRoom).not.toHaveBeenCalled()
  transport.leave('vault'); expect(node.leaveRoom).toHaveBeenCalledTimes(1)
  const third = transport.join('vault'); await vi.waitFor(() => expect(node.joinRoomAsync).toHaveBeenCalledTimes(2))
  transport.leave('vault'); release(); await third
  expect(node.leaveRoom).toHaveBeenCalledTimes(2)
})
it('recovers failed initialization and supports injected event numbers', async () => {
  const { node, options } = setup()
  vi.mocked(node.init).mockRejectedValueOnce(new Error('Unavailable'))
  const transport = createMistVaultTransport({ ...options, events: { raw: 10, peerConnected: 11, peerDisconnected: 12 } })
  await expect(transport.join('vault')).rejects.toThrow('Unavailable')
  await transport.join('vault'); transport.leave('vault')
  expect(node.init).toHaveBeenCalledTimes(2)
})
