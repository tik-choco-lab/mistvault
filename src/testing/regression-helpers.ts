import { afterEach, expect, vi } from 'vitest'
import { createVault } from '../controller.js'
import type { VaultAdapter, VaultController, VaultOptions } from '../controller.js'
import { EscrowClient } from '../core/client.js'
import type { EscrowTransport } from '../core/client.js'
import { deriveEscrowKeys, utf8 } from '../core/crypto.js'
import { stableStringify } from '../core/head.js'
import { defaultSettings, saveSettings } from '../settings.js'
import { MemoryProvider, memoryStorage } from './memory.js'

export { MemoryProvider, memoryStorage }
export const app = 'tc-sync-test', schema = 'sync/vault/1'
export const code = 'tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa'
export const otherCode = 'tcv1-bbbbbbbbbbbbbbbbbbbbbbbbba'
export type Data = { records: Record<string, { at: number; value: string }>; files: { id: string; size: number }[] }
export const empty = (): Data => ({ records: {}, files: [] })
export const record = (value: string, at = 1): Data => ({ ...empty(), records: { item: { at, value } } })
const controllers: VaultController[] = [], clients: EscrowClient[] = []
afterEach(() => {
  for (const v of controllers.splice(0)) v.dispose()
  for (const c of clients.splice(0)) c.dispose()
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})
export function client(provider: MemoryProvider, room = 'vault') {
  const c = new EscrowClient(provider, room); clients.push(c); return c
}
export function settings(storage: Storage) {
  saveSettings({ ...defaultSettings(), code, mode: 'custom', room: 'vault' }, storage)
}
export function harness(provider = new MemoryProvider(), storage = memoryStorage(), box = { data: empty() }) {
  const listeners = new Set<() => void>()
  const adapter: VaultAdapter<Data> = {
    app, schema, snapshot: () => structuredClone(box.data), parse: x => x as Data,
    merge(local, remote) {
      const records = { ...remote.records }
      for (const [id, r] of Object.entries(local.records)) if (!records[id] || r.at >= records[id].at) records[id] = r
      return { records, files: [...new Map([...remote.files, ...local.files].map(f => [f.id, f])).values()] }
    },
    apply(next) { box.data = next; for (const cb of listeners) cb() },
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
  return { adapter, provider, storage, box,
    edit(next: Data) { box.data = next; for (const cb of listeners) cb() },
    start(transport: EscrowTransport = provider, options: Pick<VaultOptions<Data>, 'now' | 'partGcGraceMs'> = {}) {
      const v = createVault({ adapter, storage, transport, ...options }); controllers.push(v); return v
    },
  }
}
export async function seed(provider: MemoryProvider, data: Data, seq = 1, parent: string | null = null) {
  const result = await client(provider).saveWithKeys(await deriveEscrowKeys(app, code), utf8(stableStringify(data)), { schema, seq, parent, comp: 'none' })
  if (result.type !== 'ack') throw new Error('Seed failed: ' + JSON.stringify(result))
  return result
}
export async function ready(v: VaultController) {
  await vi.waitFor(() => expect(['upToDate', 'restored', 'saved']).toContain(v.getView().status), { timeout: 5000 })
}
export async function remote(provider: MemoryProvider): Promise<Data> {
  const latest = await client(provider).fetchLatestWithKeys(await deriveEscrowKeys(app, code))
  if (!latest) throw new Error('Missing remote')
  return JSON.parse(new TextDecoder().decode(latest.plaintext))
}
