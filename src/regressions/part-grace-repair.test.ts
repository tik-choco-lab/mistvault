import { expect, it, vi } from 'vitest'
import { collectParts, DEFAULT_PART_GC_GRACE_MS, observePartReferences, uploadParts } from '../parts.js'
import { defaultAppState, loadAppState, saveAppState } from '../settings.js'
import { derivePartKeys, utf8 } from '../core/crypto.js'
import { app, code, client, empty, harness, MemoryProvider, memoryStorage, seed, settings } from '../testing/regression-helpers.js'

const id = 'f:attachment', bytes = utf8('attachment')
const referenced = () => ({ ...empty(), files: [{ id, size: bytes.length }] })
const localParts = () => ({ list: (s: ReturnType<typeof empty>) => s.files, read: async () => bytes,
  has: async () => true, write: vi.fn(async () => {}) })

it('persists the default 24 hour grace across reloads and collects only at its boundary', async () => {
  const provider = new MemoryProvider(), storage = memoryStorage(), c = client(provider)
  let time = 1000
  const ctx = { app, code, client: c, state: defaultAppState(), adapter: localParts(), active: () => true,
    now: () => time, persist() { saveAppState(app, this.state, storage) } }
  await uploadParts(ctx, referenced())
  const main = await seed(provider, empty()), keys = await derivePartKeys(app, code, id)
  await collectParts(ctx, empty(), main.head)
  expect(ctx.state.parts[id].unreferencedSince).toBe(1000)
  ctx.state = loadAppState(app, storage)
  time += DEFAULT_PART_GC_GRACE_MS - 1
  await collectParts(ctx, empty(), main.head)
  expect(provider.heads.has(keys.slot)).toBe(true)
  expect(provider.requests.some(m => m.type === 'escrow_delete')).toBe(false)
  time++
  await collectParts(ctx, empty(), main.head)
  expect(provider.heads.has(keys.slot)).toBe(false)
})

it('resets grace on both observed remote references and newly acknowledged references', async () => {
  const h = harness(); settings(h.storage); h.box.data = referenced(); h.adapter.parts = localParts()
  let time = 1000
  const v = h.start(h.provider, { now: () => time, partGcGraceMs: 100 })
  await v.saveNow()
  h.edit(empty()); await v.saveNow()
  expect(loadAppState(app, h.storage).parts[id].unreferencedSince).toBe(1000)
  let state = loadAppState(app, h.storage)
  await seed(h.provider, referenced(), state.lastSeq + 1, state.lastHash)
  time = 1050; await v.restoreNow()
  expect(loadAppState(app, h.storage).parts[id].unreferencedSince).toBeUndefined()
  h.edit(empty()); time = 1075; await v.saveNow()
  expect(loadAppState(app, h.storage).parts[id].unreferencedSince).toBe(1075)
  h.edit(referenced()); time = 1100; await v.saveNow()
  expect(loadAppState(app, h.storage).parts[id].unreferencedSince).toBeUndefined()
  h.edit(empty()); time = 1125; await v.saveNow()
  state = loadAppState(app, h.storage)
  expect(state.parts[id].unreferencedSince).toBe(1125)
  expect(h.provider.requests.some(m => m.type === 'escrow_delete')).toBe(false)
})

it('repairs a deletion that lands during the main PUT immediately after its ACK', async () => {
  const h = harness(); settings(h.storage); h.box.data = referenced(); h.adapter.parts = localParts()
  const v = h.start(); await v.saveNow()
  const keys = await derivePartKeys(app, code, id), c = client(h.provider)
  let deleted = false
  h.provider.beforePut = async m => {
    if (!deleted && m.head.slot !== keys.slot) {
      deleted = true
      expect(await c.deleteWithKeys(keys, h.provider.heads.get(keys.slot)!)).toEqual({ type: 'deleted' })
    }
  }
  h.edit(referenced()); await v.saveNow()
  expect(deleted).toBe(true)
  expect(v.getView().status).toBe('saved')
  expect((await c.fetchLatestWithKeys(keys))?.plaintext).toEqual(bytes)
  expect(h.provider.heads.get(keys.slot)?.seq).toBe(2)
})

it('repairs missing cached parts on an explicit save even without local edits', async () => {
  const h = harness(); settings(h.storage); h.box.data = referenced(); h.adapter.parts = localParts()
  const v = h.start(); await v.saveNow()
  const seq = v.getView().lastSeq, keys = await derivePartKeys(app, code, id)
  h.provider.heads.delete(keys.slot)
  await v.saveNow()
  expect((await client(h.provider).fetchLatestWithKeys(keys))?.plaintext).toEqual(bytes)
  expect(v.getView().lastSeq).toBe(seq)
})

it('does not restart grace from a stale collection after observing a newer referenced main', async () => {
  const provider = new MemoryProvider(), c = client(provider)
  const ctx = { app, code, client: c, state: defaultAppState(), adapter: localParts(), active: () => true, persist() {} }
  await uploadParts(ctx, referenced())
  const old = await seed(provider, empty())
  let arrived!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { arrived = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const get = c.getHead.bind(c)
  vi.spyOn(c, 'getHead').mockImplementation(async slot => {
    if (slot === old.head.slot) { arrived(); await gate; return old.head }
    return get(slot)
  })
  const collection = collectParts(ctx, empty(), old.head)
  await waiting
  try {
    const current = await seed(provider, referenced(), 2, old.hash)
    observePartReferences(ctx, referenced(), current.head)
    release(); await collection
    expect(ctx.state.parts[id].unreferencedSince).toBeUndefined()
    expect(provider.requests.some(m => m.type === 'escrow_delete')).toBe(false)
  } finally { release(); await collection }
})

it('invalidates a missing uploaded record even if restore repair fails, then retries with local bytes', async () => {
  const h = harness(); settings(h.storage); h.box.data = referenced(); h.adapter.parts = localParts()
  const v = h.start(); await v.saveNow()
  const keys = await derivePartKeys(app, code, id), c = client(h.provider)
  await c.deleteWithKeys(keys, h.provider.heads.get(keys.slot)!)
  h.provider.quota.add(keys.slot)
  await v.restoreNow()
  expect(loadAppState(app, h.storage).parts[id]).toBeUndefined()
  expect(v.getView().parts.pending).toBe(1)
  h.provider.quota.clear()
  await v.restoreNow()
  expect((await c.fetchLatestWithKeys(keys))?.plaintext).toEqual(bytes)
  expect(v.getView().parts.pending).toBe(0)
  expect(h.adapter.parts.write).not.toHaveBeenCalled()
})

it('keeps an unavailable part pending without exposing placeholder bytes and retries on a visible poll', async () => {
  const h = harness(); settings(h.storage); await seed(h.provider, referenced())
  const files = new Map<string, Uint8Array>()
  const write = vi.fn(async (key: string, value: Uint8Array) => { files.set(key, value) })
  h.adapter.parts = { list: s => s.files, read: async key => files.get(key) ?? null,
    has: async key => files.has(key), write }
  vi.useFakeTimers()
  const v = h.start(); await v.restoreNow()
  expect(v.getView().parts.pending).toBe(1)
  expect(write).not.toHaveBeenCalled(); expect(files.size).toBe(0)
  await uploadParts({ app, code, client: client(h.provider), state: defaultAppState(), adapter: localParts(),
    active: () => true, persist() {} }, referenced())
  await vi.advanceTimersByTimeAsync(60000)
  await vi.waitFor(() => expect(files.get(id)).toEqual(bytes))
  expect(v.getView().parts.pending).toBe(0)
  expect(write).toHaveBeenCalledTimes(1)
})

it('keeps failed downloads pending and retries without applying placeholder bytes', async () => {
  const h = harness(); settings(h.storage)
  await uploadParts({ app, code, client: client(h.provider), state: defaultAppState(), adapter: localParts(),
    active: () => true, persist() {} }, referenced())
  await seed(h.provider, referenced())
  const files = new Map<string, Uint8Array>(), write = vi.fn(async (key: string, value: Uint8Array) => { files.set(key, value) })
  h.adapter.parts = { list: s => s.files, read: async key => files.get(key) ?? null,
    has: async key => files.has(key), write }
  const keys = await derivePartKeys(app, code, id), cid = h.provider.heads.get(keys.slot)!.cid
  const get = h.provider.storageGet.getMockImplementation()!
  h.provider.storageGet.mockImplementation(async key => { if (key === cid) throw new Error('Unavailable'); return get(key) })
  const v = h.start(); await v.restoreNow()
  expect(v.getView().parts.pending).toBe(1); expect(write).not.toHaveBeenCalled()
  h.provider.storageGet.mockImplementation(get)
  await v.restoreNow()
  expect(files.get(id)).toEqual(bytes); expect(v.getView().parts.pending).toBe(0)
})
