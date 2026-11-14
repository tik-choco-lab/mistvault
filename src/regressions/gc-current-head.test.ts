import { expect, it, vi } from 'vitest'
import { collectParts, PART_SCHEMA } from '../parts.js'
import { defaultAppState } from '../settings.js'
import { derivePartKeys, sha256, utf8 } from '../core/crypto.js'
import { client, code, app, empty, MemoryProvider, seed, remote } from '../testing/regression-helpers.js'

it('keeps a part referenced by a newer main ACK arriving during collection', async () => {
  const provider = new MemoryProvider(), c = client(provider), keys = await derivePartKeys(app, code, 'f:document')
  const bytes = utf8('only surviving attachment copy')
  const part = await c.saveWithKeys(keys, bytes, { schema: PART_SCHEMA, seq: 1, parent: null, comp: 'none' })
  expect(part.type).toBe('ack')
  const main = await seed(provider, empty())
  const state = { ...defaultAppState(), parts: { 'f:document': { seq: 1, hash: await sha256(bytes) } } }
  const getHead = c.getHead.bind(c)
  let newer = false
  vi.spyOn(c, 'getHead').mockImplementation(async (slot, timeout) => {
    if (slot === keys.slot && !newer) {
      newer = true
      await seed(provider, { ...empty(), files: [{ id: 'f:document', size: bytes.length }] }, 2, main.hash)
    }
    return getHead(slot, timeout)
  })
  await collectParts({ app, code, client: c, state, active: () => true, persist() {}, partGcGraceMs: 0,
    adapter: { list: s => s.files, read: async () => bytes, has: async () => true, write: async () => {} },
  }, empty(), main.head)
  expect(newer).toBe(true)
  expect((await remote(provider)).files[0].id).toBe('f:document')
  expect(provider.heads.has(keys.slot)).toBe(true)
})

it('keeps a newer part generation another device uploaded ahead of its main PUT', async () => {
  const provider = new MemoryProvider(), c = client(provider), keys = await derivePartKeys(app, code, 'f:mutable')
  const oldBytes = utf8('old attachment')
  const old = await c.saveWithKeys(keys, oldBytes, { schema: PART_SCHEMA, seq: 1, parent: null, comp: 'none' })
  if (old.type !== 'ack') throw new Error('Seed failed')
  const main = await seed(provider, empty())
  const state = { ...defaultAppState(), parts: { 'f:mutable': { seq: 1, hash: await sha256(oldBytes) } } }
  // Another device has received a part ACK and will next publish its main.
  const newer = await client(provider).saveWithKeys(keys, utf8('new attachment'), {
    schema: PART_SCHEMA, seq: 2, parent: old.hash, comp: 'none',
  })
  expect(newer.type).toBe('ack')
  await collectParts({ app, code, client: c, state, active: () => true, persist() {}, partGcGraceMs: 0,
    adapter: { list: s => s.files, read: async () => null, has: async () => true, write: async () => {} },
  }, empty(), main.head)
  expect(provider.heads.get(keys.slot)?.seq).toBe(2)
})
