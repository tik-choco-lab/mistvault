import { expect, it } from 'vitest'
import { collectParts, fetchParts, uploadParts } from '../parts.js'
import { defaultAppState } from '../settings.js'
import { derivePartKeys, utf8 } from '../core/crypto.js'
import { app, code, client, empty, MemoryProvider, seed, remote } from '../testing/regression-helpers.js'

it('repairs a cached part deleted after another device acknowledges its reuse', async () => {
  const provider = new MemoryProvider(), a = client(provider), b = client(provider)
  const id = 'f:immutable', bytes = utf8('attachment'), referenced = { ...empty(), files: [{ id, size: bytes.length }] }
  const adapter = { list: (s: typeof referenced) => s.files, read: async () => bytes, has: async () => true, write: async () => {} }
  const aState = defaultAppState()
  const aCtx = { app, code, client: a, state: aState, active: () => true, persist() {}, adapter, partGcGraceMs: 0 }
  await uploadParts(aCtx, referenced)
  const bState = structuredClone(aState)
  const first = await seed(provider, referenced)
  const removed = await seed(provider, empty(), 2, first.hash)
  let arrived!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { arrived = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const answer = provider.answer.bind(provider)
  provider.answer = async (room, message) => {
    // Normal network/server scheduling: the part DELETE is delayed independently of main PUTs.
    if (message.type === 'escrow_delete') { arrived(); await gate }
    await answer(room, message)
  }
  const collection = collectParts(aCtx, empty(), removed.head)
  await waiting
  try {
    await uploadParts({ ...aCtx, client: b, state: bState }, referenced)
    const keys = await derivePartKeys(app, code, id)
    await seed(provider, referenced, 3, removed.hash)
    release(); await collection
    expect((await remote(provider)).files).toEqual(referenced.files)
    expect(provider.failures).toEqual([])
    expect(await b.fetchLatestWithKeys(keys)).toBeNull()
    expect(await fetchParts({ ...aCtx, client: b, state: bState }, referenced)).toBe(0)
    expect((await b.fetchLatestWithKeys(keys))?.plaintext).toEqual(bytes)
  } finally { release(); await collection }
})
