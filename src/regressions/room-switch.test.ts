import { expect, it } from 'vitest'
import { headHash } from '../core/head.js'
import { app, code, empty, harness, MemoryProvider, record, ready, seed, settings } from '../testing/regression-helpers.js'
import { deriveEscrowKeys, derivePartKeys, utf8 } from '../core/crypto.js'
import type { EscrowTransport } from '../core/client.js'

it('restores a different room even if its sequence equals the previous room watermark', async () => {
  const h = harness(); settings(h.storage)
  const a = await seed(h.provider, record('room A', 1))
  const v = h.start(); await ready(v)
  expect(v.getView().lastSeq).toBe(1)
  // Each mistl room has its own slot namespace. Replace the served room's
  // head when switching, keeping real signed/encrypted records for both.
  const keys = await deriveEscrowKeys(app, code)
  h.provider.heads.delete(keys.slot)
  const b = await seed(h.provider, record('room B newer record', 2))
  expect(a.seq).toBe(b.seq); expect(await headHash(a.head)).not.toBe(b.hash)
  expect(v.configure('custom', 'other-room')).toBe(true)
  await ready(v)
  expect(h.box.data.records.item.value).toBe('room B newer record')
})

it('uploads attachments into the new room instead of trusting the old room cache', async () => {
  const a = new MemoryProvider(), b = new MemoryProvider(), h = harness(a)
  settings(h.storage)
  const get = (room: string) => room === 'vault' ? a : b
  const blobs = new Map<string, Uint8Array>()
  const transport: EscrowTransport = {
    join: room => get(room).join(room), leave: room => get(room).leave(room),
    send: (room, to, bytes) => get(room).send(room, to, bytes),
    onMessage: (room, cb) => get(room).onMessage(room, cb),
    onPeer: (room, cb) => get(room).onPeer(room, cb),
    storageAdd: async (_name, bytes) => {
      const cid = 'cid-' + blobs.size; blobs.set(cid, bytes)
      a.blobs.set(cid, bytes); b.blobs.set(cid, bytes); return cid
    },
    storageGet: async cid => { const bytes = blobs.get(cid); if (!bytes) throw new Error('Missing blob'); return bytes },
  }
  const bytes = utf8('room-scoped attachment')
  h.box.data = { ...empty(), files: [{ id: 'f:document', size: bytes.length }] }
  h.adapter.parts = { list: s => s.files, read: async () => bytes, has: async () => true, write: async () => {} }
  const v = h.start(transport); await v.saveNow()
  const part = await derivePartKeys(app, code, 'f:document'), main = await deriveEscrowKeys(app, code)
  expect(a.heads.has(part.slot)).toBe(true)
  v.configure('custom', 'other-room'); await ready(v); await v.saveNow()
  expect(b.heads.has(main.slot)).toBe(true)
  expect(b.heads.has(part.slot)).toBe(true)
})
