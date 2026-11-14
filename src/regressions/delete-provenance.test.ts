import { expect, it } from 'vitest'
import { EscrowClient } from '../core/client.js'
import type { EscrowTransport } from '../core/client.js'
import { deriveEscrowKeys } from '../core/crypto.js'
import { buildHead, headHash } from '../core/head.js'
import type { EscrowHead } from '../core/head.js'
import { encodeEscrowMessage, parseEscrowMessage } from '../core/protocol.js'
import type { EscrowMessage } from '../core/protocol.js'
import { app, code, schema } from '../testing/regression-helpers.js'

it('never confirms deletion after evicting a known departed copy from provenance', async () => {
  let receive!: (from: string, bytes: Uint8Array) => void
  let peer!: (id: string, joined: boolean) => void
  const copies = new Map<string, EscrowHead | null>()
  const reply = (id: string, message: EscrowMessage) => receive(id, encodeEscrowMessage(message))
  const transport: EscrowTransport = {
    join: async () => {}, leave() {},
    onMessage(_room, cb) { receive = cb; return () => {} },
    onPeer(_room, cb) { peer = cb; return () => {} },
    storageAdd: async () => 'unused', storageGet: async () => new Uint8Array(),
    send(_room, to, bytes) {
      const m = parseEscrowMessage(bytes)!
      if (m.type === 'escrow_get') reply(to!, { v: 1, type: 'escrow_head', id: m.id, slot: m.slot, head: copies.get(to!) ?? null })
      if (m.type === 'escrow_delete') {
        if (copies.get(to!)) throw new Error('This test deletes only at the absent provider')
        reply(to!, { v: 1, type: 'escrow_deleted', id: m.id, slot: m.slot })
      }
    },
  }
  const c = new EscrowClient(transport, 'vault'), keys = await deriveEscrowKeys(app, code)
  const advertise = (id: string) => reply(id, { v: 1, type: 'escrow_provider', version: 1, maxBlob: 33554432, features: ['delete'] })
  const fields = { schema, comp: 'none' as const, cid: 'cid-original', size: 28, sha256: 'a'.repeat(64) }
  try {
    await c.join()
    const original = await buildHead(keys, { ...fields, seq: 1, parent: null })
    copies.set('departed', original); advertise('departed')
    expect(await c.getHead(keys.slot)).toEqual(original)
    peer('departed', false)
    advertise('online')
    let current = original
    for (let i = 2; i <= 1025; i++) {
      current = await buildHead(keys, { ...fields, cid: 'cid-' + i, seq: i, parent: await headHash(current) })
      copies.set('online', current)
      expect((await c.getHead(keys.slot))?.seq).toBe(i)
    }
    copies.set('online', null)
    const result = await c.deleteWithKeys(keys, original)
    expect(copies.get('departed')).toEqual(original)
    expect(result.type).not.toBe('deleted')
  } finally { c.dispose() }
}, 30000)
