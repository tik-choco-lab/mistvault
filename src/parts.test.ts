import { expect, it, vi } from 'vitest'
import { decryptBlob, deriveEscrowKeys, derivePartKeys, fromHex, hex, utf8 } from './core/crypto.js'
import { EscrowClient } from './core/client.js'
import { MemoryProvider } from './testing/memory.js'
import { listedParts, mapParts } from './parts.js'

const vectors = [
  { part: 'f:0123456789abcdef', slot: '8806befe3e3003e8185b498fdcfee507', writer: '-vkNOQaAFiQ117-Q5mwB2XVmFRPfS_958t00UMWWYlM',
    sig: '1371bb3a914417f5e07c9d37c5281a5bc6c8503dd91cde20fd9d683e435f197d25ef47e8f90dfaa4c1e33468e4c1eca48581b327f097db0b22ebfa496e12150d',
    ciphertext: 'fc53f13d09ee76e08eed30641bd8b21bfca3dfc498bf056bc1e15d' },
  { part: 'cover.png', slot: '247cd34923209061829fbe989a8e556a', writer: 'KeB2uDzX5hDem3RahlzwhkYteELPCT4ttnOpYi9tXmk',
    sig: '26488dee592d778ef51312935ce5cc1345da007ba6c9e3cb94104d5cd10cb2ea42c6399803c3fb2d16d6f9085eef1cffe59da1befc434711a504d94a3dc3ce05',
    ciphertext: 'f4b9e436a63f795a31fb5b6ae965fc1d5aa735bf7fe18718efbe40' },
]
it.each(vectors)('matches fixed slot, writer, signature and AES vectors for $part', async vector => {
  const keys = await derivePartKeys('tc-books', 'tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa', vector.part)
  expect(keys.slot).toBe(vector.slot); expect(keys.writer).toBe(vector.writer)
  expect(hex(await keys.sign(utf8('part vector')))).toBe(vector.sig)
  const blob = new Uint8Array(12 + vector.ciphertext.length / 2); blob.set(fromHex(vector.ciphertext), 12)
  expect(await decryptBlob(keys.encKey, keys.slot, 1, blob)).toEqual(utf8('part vector'))
})
it('shares one PBKDF2 master with the main slot and caches parts', async () => {
  const spy = vi.spyOn(crypto.subtle, 'deriveBits')
  try {
    const [main, a, b] = await Promise.all([deriveEscrowKeys('cache-test', 'code'), derivePartKeys('cache-test', 'code', 'a'), derivePartKeys('cache-test', 'code', 'b')])
    expect(new Set([main.slot, a.slot, b.slot]).size).toBe(3)
    expect(spy.mock.calls.filter(([alg]) => (alg as Algorithm).name === 'PBKDF2')).toHaveLength(1)
    expect(await derivePartKeys('cache-test', 'code', 'a')).toBe(a)
    expect(() => derivePartKeys('a', 'b', 'bad/id')).toThrow()
  } finally { spy.mockRestore() }
})
it('saves, fetches and deletes using part keys', async () => {
  const provider = new MemoryProvider(), client = new EscrowClient(provider, 'test')
  try {
    const keys = await derivePartKeys('parts-client', 'code', 'f:test')
    const result = await client.saveWithKeys(keys, utf8('attachment'), { schema: 'test/1', seq: 1, parent: null })
    expect(result.type).toBe('ack')
    expect((await client.fetchLatestWithKeys(keys))?.plaintext).toEqual(utf8('attachment'))
    if (result.type === 'ack') expect(await client.deleteWithKeys(keys, result.head)).toEqual({ type: 'deleted' })
    expect(await client.fetchLatestWithKeys(keys)).toBeNull()
  } finally { client.dispose() }
})
it('bounds attachment concurrency and validates ids', async () => {
  let busy = 0, peak = 0
  await mapParts([1, 2, 3, 4, 5], async () => { busy++; peak = Math.max(peak, busy); await new Promise(resolve => setTimeout(resolve, 5)); busy-- })
  expect(peak).toBe(2)
  const adapter = { list: () => [{ id: 'a', size: 1 }, { id: 'a', size: 1 }], read: async () => null, has: async () => false, write: async () => {} }
  expect(() => listedParts(adapter, {})).toThrow()
})
