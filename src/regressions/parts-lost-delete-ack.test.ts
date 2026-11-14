import { expect, it, vi } from 'vitest'
import { derivePartKeys, utf8 } from '../core/crypto.js'
import { loadAppState } from '../settings.js'
import { app, code, empty, harness, remote, settings } from '../testing/regression-helpers.js'

it('reuploads a reintroduced attachment after its DELETE succeeded but ACK was lost', async () => {
  const h = harness(); settings(h.storage)
  const bytes = utf8('document'), part = await derivePartKeys(app, code, 'f:document')
  const referenced = { ...empty(), files: [{ id: 'f:document', size: bytes.length }] }
  h.box.data = referenced
  h.adapter.parts = { list: s => s.files, read: async () => bytes, has: async () => true, write: async () => {} }
  const v = h.start(h.provider, { partGcGraceMs: 0 }); await v.saveNow()
  const reply = h.provider.reply.bind(h.provider)
  h.provider.reply = (room, message) => { if (message.type !== 'escrow_deleted') reply(room, message) }
  vi.useFakeTimers()
  h.edit(empty()); await v.saveNow()
  await vi.waitFor(() => expect(h.provider.tombstones.has(part.slot)).toBe(true))
  await vi.advanceTimersByTimeAsync(45000)
  expect(loadAppState(app, h.storage).parts['f:document']).toBeUndefined()
  expect(loadAppState(app, h.storage).pendingDeletes?.['f:document']).toBeDefined()
  h.edit(referenced); await v.saveNow()
  expect(v.getView().status).toBe('saved')
  expect((await remote(h.provider)).files[0].id).toBe('f:document')
  expect(h.provider.heads.has(part.slot)).toBe(true)
})

it('checks cached part heads and reuploads an absent part before the main PUT', async () => {
  const h = harness(); settings(h.storage)
  const bytes = utf8('document'), part = await derivePartKeys(app, code, 'f:document')
  const referenced = { ...empty(), files: [{ id: 'f:document', size: bytes.length }] }
  h.box.data = referenced
  h.adapter.parts = { list: s => s.files, read: async () => bytes, has: async () => true, write: async () => {} }
  const v = h.start(); await v.saveNow()
  h.provider.heads.delete(part.slot); h.provider.requests.length = 0
  h.edit(referenced); await v.saveNow()
  expect(h.provider.heads.has(part.slot)).toBe(true)
  const requests = h.provider.requests
  const check = requests.findIndex(m => m.type === 'escrow_get' && m.slot === part.slot)
  const partPut = requests.findIndex(m => m.type === 'escrow_put' && m.head.slot === part.slot)
  const mainPut = requests.findIndex(m => m.type === 'escrow_put' && m.head.slot !== part.slot)
  expect(check).toBeGreaterThanOrEqual(0)
  expect(partPut).toBeGreaterThan(check); expect(mainPut).toBeGreaterThan(partPut)
})
