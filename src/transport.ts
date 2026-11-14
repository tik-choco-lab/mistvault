import type { EscrowTransport } from './core/client.js'
import { MAX_MESSAGE_BYTES } from './core/protocol.js'

export interface MistNodeLike {
  init(): Promise<void>
  onEvent(h: (eventType: number, fromId: string, payload: unknown, roomId?: string) => void): void
  joinRoom(roomId: string): void | Promise<void>
  joinRoomAsync?(roomId: string): Promise<void>
  leaveRoom(roomId?: string): void
  sendMessage(to: string | null | undefined, payload: Uint8Array, delivery?: 0 | 1 | 2 | 3, roomId?: string): void
}
export interface MistVaultTransportOptions {
  createNode(): MistNodeLike
  storageAdd(name: string, bytes: Uint8Array): Promise<string>
  storageGet(cid: string): Promise<Uint8Array>
  events?: { raw: number; peerConnected: number; peerDisconnected: number }
}
type Room = { node: MistNodeLike; refs: number; ready: boolean; joined: Promise<void>; queue: { to: string | null; bytes: Uint8Array }[] }
const sharedDownloads = new WeakMap<MistVaultTransportOptions['storageGet'], Map<string, Promise<Uint8Array>>>()
export function createMistVaultTransport(o: MistVaultTransportOptions): EscrowTransport {
  const events = o.events ?? { raw: 0, peerConnected: 2, peerDisconnected: 3 }
  const rooms = new Map<string, Room>()
  const messages = new Map<string, Set<(id: string, bytes: Uint8Array) => void>>()
  const peers = new Map<string, Set<(id: string, joined: boolean) => void>>()
  const downloads = sharedDownloads.get(o.storageGet) ?? new Map<string, Promise<Uint8Array>>()
  sharedDownloads.set(o.storageGet, downloads)
  function subscribe<T>(map: Map<string, Set<T>>, room: string, cb: T) {
    const set = map.get(room) ?? new Set<T>(); map.set(room, set); set.add(cb)
    return () => { set.delete(cb); if (!set.size) map.delete(room) }
  }
  return {
    join(id) {
      const old = rooms.get(id)
      if (old) { old.refs++; return old.joined }
      const n = o.createNode()
      const room: Room = { node: n, refs: 1, ready: false, joined: Promise.resolve(), queue: [] }
      rooms.set(id, room)
      n.onEvent((type, from, payload, roomId) => {
        if (rooms.get(id) !== room || !room.refs || roomId !== undefined && roomId !== id) return
        if (type === events.raw) {
          const bytes = toBytes(payload)
          if (bytes && bytes.byteLength <= MAX_MESSAGE_BYTES) for (const cb of messages.get(id) ?? []) cb(from, bytes)
        } else if (type === events.peerConnected || type === events.peerDisconnected) {
          for (const cb of peers.get(id) ?? []) cb(from, type === events.peerConnected)
        }
      })
      room.joined = (async () => {
        await n.init()
        if (!room.refs) { rooms.delete(id); n.leaveRoom(id); return }
        await (n.joinRoomAsync ? n.joinRoomAsync(id) : n.joinRoom(id))
        if (!room.refs) { n.leaveRoom(id); rooms.delete(id); return }
        room.ready = true
        for (const m of room.queue.splice(0)) n.sendMessage(m.to, m.bytes, 0, id)
      })().catch(error => {
        room.queue.length = 0
        if (rooms.get(id) === room) { rooms.delete(id); n.leaveRoom(id) }
        throw error
      })
      return room.joined
    },
    leave(id) {
      const room = rooms.get(id)
      if (!room || !room.refs || --room.refs) return
      room.queue.length = 0
      if (room.ready) { rooms.delete(id); room.node.leaveRoom(id) }
    },
    send(id, to, bytes) {
      const room = rooms.get(id)
      if (!room?.refs) throw new Error('Vault room not joined')
      if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error('Vault message exceeds limit')
      if (room.ready) room.node.sendMessage(to, bytes, 0, id)
      else {
        if (room.queue.length >= 64) throw new Error('Vault join queue full')
        room.queue.push({ to, bytes: new Uint8Array(bytes) })
      }
    },
    onMessage: (room, cb) => subscribe(messages, room, cb),
    onPeer: (room, cb) => subscribe(peers, room, cb),
    storageAdd: (name, bytes) => o.storageAdd(name, bytes),
    storageGet(cid) {
      cid = cid.trim()
      const old = downloads.get(cid)
      if (old) return old
      const pending = Promise.resolve().then(() => o.storageGet(cid))
      downloads.set(cid, pending)
      const clear = () => { if (downloads.get(cid) === pending) downloads.delete(cid) }
      void pending.then(clear, clear)
      return pending
    },
  }
}
function toBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  return Array.isArray(payload) && payload.length <= MAX_MESSAGE_BYTES && payload.every(x => Number.isInteger(x) && x >= 0 && x <= 255)
    ? Uint8Array.from(payload) : null
}
