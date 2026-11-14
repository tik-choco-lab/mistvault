import { vi } from 'vitest'
import type { EscrowTransport } from '../core/client.js'
import { headHash, verifyHead, deleteSigningPayload } from '../core/head.js'
import type { EscrowHead } from '../core/head.js'
import { fromBase64url } from '../core/crypto.js'
import { encodeEscrowMessage, parseEscrowMessage } from '../core/protocol.js'
import type { EscrowMessage, EscrowPut } from '../core/protocol.js'

export function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, clear: () => values.clear(), key: n => [...values.keys()][n] ?? null,
    getItem: k => values.get(k) ?? null, removeItem: k => { values.delete(k) }, setItem: (k, v) => { values.set(k, v) } }
}
/** A protocol-level provider with real encrypted blobs, signatures and compare-and-swap. */
export class MemoryProvider implements EscrowTransport {
  readonly heads = new Map<string, EscrowHead>()
  readonly tombstones = new Map<string, EscrowHead>()
  readonly blobs = new Map<string, Uint8Array>()
  readonly requests: EscrowMessage[] = []
  readonly messages = new Map<string, Set<(from: string, bytes: Uint8Array) => void>>()
  readonly peers = new Map<string, Set<(id: string, joined: boolean) => void>>()
  online = true
  quota = new Set<string>()
  beforePut?: (message: EscrowPut) => Promise<void>
  join = vi.fn(async (_room: string) => {})
  leave = vi.fn((_room: string) => {})
  storageAdd = vi.fn(async (_name: string, bytes: Uint8Array) => {
    const cid = 'cid-' + this.blobs.size; this.blobs.set(cid, new Uint8Array(bytes)); return cid
  })
  storageGet = vi.fn(async (cid: string) => {
    const bytes = this.blobs.get(cid); if (!bytes) throw new Error('Missing blob'); return bytes
  })
  onMessage(room: string, cb: (from: string, bytes: Uint8Array) => void) {
    const set = this.messages.get(room) ?? new Set(); this.messages.set(room, set); set.add(cb)
    return () => { set.delete(cb) }
  }
  onPeer(room: string, cb: (id: string, joined: boolean) => void) {
    const set = this.peers.get(room) ?? new Set(); this.peers.set(room, set); set.add(cb)
    return () => { set.delete(cb) }
  }
  send(room: string, _to: string | null, bytes: Uint8Array) {
    const message = parseEscrowMessage(bytes)
    if (!message) throw new Error('Invalid request')
    this.requests.push(message)
    if (this.online) void this.answer(room, message).catch(e => { this.failures.push(e) })
  }
  failures: unknown[] = []
  reply(room: string, message: EscrowMessage) { for (const cb of this.messages.get(room) ?? []) cb('provider', encodeEscrowMessage(message)) }
  advertise() { for (const room of this.messages.keys()) this.reply(room, { v: 1, type: 'escrow_provider', version: 1, maxBlob: 33554432, features: ['delete', 'delete-continue'] }) }
  async answer(room: string, m: EscrowMessage) {
    if (m.type === 'escrow_hello') { this.advertise(); return }
    if (m.type === 'escrow_get') { this.reply(room, { v: 1, type: 'escrow_head', id: m.id, slot: m.slot, head: this.heads.get(m.slot) ?? null }); return }
    if (m.type === 'escrow_put') {
      await this.beforePut?.(m)
      const h = m.head, old = this.heads.get(h.slot), tombstone = this.tombstones.get(h.slot)
      if (!await verifyHead(h, { slot: h.slot, writer: h.writer })) throw new Error('Invalid signature')
      if (this.quota.has(h.slot)) { this.reply(room, { v: 1, type: 'escrow_error', id: m.id, code: 'quota', message: 'Full' }); return }
      if (!old && tombstone && (h.seq !== tombstone.seq + 1 || h.parent !== await headHash(tombstone))) {
        this.reply(room, { v: 1, type: 'escrow_error', id: m.id, code: 'deleted', head: tombstone, message: 'Deleted' }); return
      }
      const hash = await headHash(h)
      if (old && hash !== await headHash(old) && (h.writer !== old.writer || h.seq !== old.seq + 1 || h.parent !== await headHash(old)) || !old && !tombstone && h.parent !== null) {
        this.reply(room, { v: 1, type: 'escrow_error', id: m.id, code: 'conflict', head: old ?? null, message: 'Changed' }); return
      }
      const blob = this.blobs.get(h.cid)
      if (!blob || blob.length !== h.size) throw new Error('Invalid blob')
      this.heads.set(h.slot, h); this.tombstones.delete(h.slot)
      this.reply(room, { v: 1, type: 'escrow_ack', id: m.id, slot: h.slot, seq: h.seq, hash }); return
    }
    if (m.type === 'escrow_delete') {
      const old = this.heads.get(m.slot)
      if (old) {
        const key = await crypto.subtle.importKey('raw', fromBase64url(old.writer), 'Ed25519', false, ['verify'])
        if (!await crypto.subtle.verify('Ed25519', key, fromBase64url(m.sig), deleteSigningPayload(m))) throw new Error('Invalid delete signature')
        if (old.seq !== m.seq || await headHash(old) !== m.head) { this.reply(room, { v: 1, type: 'escrow_error', id: m.id, code: 'conflict', head: old, message: 'Changed' }); return }
        this.heads.delete(m.slot); this.tombstones.set(m.slot, old)
      }
      this.reply(room, { v: 1, type: 'escrow_deleted', id: m.id, slot: m.slot })
    }
  }
}
