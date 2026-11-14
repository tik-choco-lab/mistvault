import { derivePartKeys, PART_ID_RE, sha256 } from './core/crypto.js'
import { DEFAULT_MAX_BLOB, headHash, verifyHead } from './core/head.js'
import type { EscrowHead } from './core/head.js'
import type { EscrowClient } from './core/client.js'
import type { VaultAppState } from './settings.js'

export interface VaultParts<S> {
  list(state: S): { id: string; size: number }[]
  read(id: string): Promise<Uint8Array | null>
  has(id: string): Promise<boolean>
  write(id: string, bytes: Uint8Array): Promise<void>
  maxBytes?: number
}
export const DEFAULT_MAX_PART_BYTES = DEFAULT_MAX_BLOB - 64 * 1024
export const DEFAULT_PART_GC_GRACE_MS = 24 * 60 * 60 * 1000
export const PART_SCHEMA = 'tc-vault/part/1'
/** Runs at most two attachment operations at a time. */
export async function mapParts<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const run = async () => { while (index < items.length) await work(items[index++]) }
  const outcomes = await Promise.allSettled([run(), run()])
  const failed = outcomes.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
export function listedParts<S>(adapter: VaultParts<S>, state: S): { id: string; size: number }[] {
  const parts = adapter.list(state), ids = new Set<string>()
  for (const p of parts) {
    if (typeof p.id !== 'string' || !PART_ID_RE.test(p.id) || !Number.isSafeInteger(p.size) || p.size < 0 || ids.has(p.id)) throw new Error('Invalid vault part list')
    ids.add(p.id)
  }
  return parts
}
export interface PartContext<S> {
  adapter: VaultParts<S>; app: string; code: string; client: EscrowClient; state: VaultAppState
  active(): boolean; persist(): void
  collecting?: Set<string>
  canCollect?(): boolean
  now?(): number
  partGcGraceMs?: number
}
/** Record references only from an acknowledged or observed current main snapshot. */
export function observePartReferences<S>(ctx: PartContext<S>, snapshot: S, main: EscrowHead): boolean {
  if (!ctx.active() || main.seq < (ctx.state.partsObservedSeq ?? 0)) return false
  const keep = new Set(listedParts(ctx.adapter, snapshot).map(p => p.id)), now = (ctx.now ?? Date.now)()
  let changed = ctx.state.partsObservedSeq !== main.seq
  ctx.state.partsObservedSeq = main.seq
  for (const inventory of [ctx.state.parts, ctx.state.pendingDeletes]) {
    for (const [id, entry] of Object.entries(inventory ?? {})) {
      if (keep.has(id)) {
        if (entry.unreferencedSince !== undefined) {
          const { unreferencedSince: _, ...referenced } = entry
          inventory![id] = referenced; changed = true
        }
      } else if (entry.unreferencedSince === undefined) {
        inventory![id] = { ...entry, unreferencedSince: now }; changed = true
      }
    }
  }
  if (changed) ctx.persist()
  return true
}
function invalidatePart<S>(ctx: PartContext<S>, id: string): void {
  if (ctx.state.parts[id]) { delete ctx.state.parts[id]; ctx.persist() }
}
export async function uploadParts<S>(ctx: PartContext<S>, snapshot: S): Promise<void> {
  await uploadListedParts(ctx, listedParts(ctx.adapter, snapshot))
}
async function uploadListedParts<S>(ctx: PartContext<S>, parts: { id: string; size: number }[], recordOmissions = true): Promise<void> {
  const { adapter, client, app, code, state } = ctx
  const omitted = new Set<string>()
  await mapParts(parts, async ({ id, size }) => {
    if (!ctx.active()) return
    const max = adapter.maxBytes ?? DEFAULT_MAX_PART_BYTES
    if (size > max) { omitted.add(id); return }
    const bytes = await adapter.read(id)
    if (!ctx.active()) return
    if (!bytes || bytes.byteLength > max) { omitted.add(id); return }
    const hash = await sha256(bytes)
    if (!ctx.active()) return
    const keys = await derivePartKeys(app, code, id)
    for (let attempt = 0; attempt < 3 && ctx.active(); attempt++) {
      const head = await client.getHead(keys.slot)
      if (!ctx.active()) return
      if (head && !await verifyHead(head, { slot: keys.slot, writer: keys.writer })) throw new Error('Invalid part head')
      if (!head) invalidatePart(ctx, id)
      const tracked = state.parts[id]
      if (head && tracked?.hash === hash && tracked.seq === head.seq && !ctx.collecting?.has(id)) {
        const generation = await headHash(head)
        if (tracked.headHash === generation) return
        if (!tracked.headHash) {
          const latest = await client.fetchLatestWithKeys(keys)
          if (!ctx.active()) return
          if (latest && await headHash(latest.head) === generation && await sha256(latest.plaintext) === hash) {
            state.parts = { ...state.parts, [id]: { ...tracked, headHash: generation } }; ctx.persist(); return
          }
        }
      }
      const result = await client.saveWithKeys(keys, bytes, { schema: PART_SCHEMA, comp: 'none',
        seq: (head?.seq ?? 0) + 1, parent: head ? await headHash(head) : null })
      if (!ctx.active()) return
      if (result.type === 'ack') {
        state.parts = { ...state.parts, [id]: { seq: result.seq, hash, headHash: result.hash } }
        delete state.pendingDeletes?.[id]; ctx.persist(); return
      }
      if (result.type === 'error') {
        if (result.code === 'deleted') invalidatePart(ctx, id)
        if (result.code === 'quota' || result.code === 'too_large') { omitted.add(id); return }
        // Deleted slots retain their sequence and parent on supporting providers.
        if (result.code === 'deleted' && result.head) {
          const retry = await client.saveWithKeys(keys, bytes, { schema: PART_SCHEMA, comp: 'none', seq: result.head.seq + 1, parent: await headHash(result.head) })
          if (!ctx.active()) return
          if (retry.type === 'ack') {
            state.parts = { ...state.parts, [id]: { seq: retry.seq, hash, headHash: retry.hash } }
            delete state.pendingDeletes?.[id]; ctx.persist(); return
          }
        }
        throw new Error(result.code + ': ' + result.message)
      }
    }
    if (ctx.active()) throw new Error('Part conflict retry limit reached')
  })
  if (ctx.active() && recordOmissions) { state.omitted = [...omitted].sort(); ctx.persist() }
}
export async function fetchParts<S>(ctx: PartContext<S>, snapshot: S): Promise<number> {
  let pending = 0
  await mapParts(listedParts(ctx.adapter, snapshot), async part => {
    const { id } = part
    if (!ctx.active()) return
    const keys = await derivePartKeys(ctx.app, ctx.code, id)
    if (!ctx.active()) return
    try {
      const head = await ctx.client.getHead(keys.slot)
      if (!ctx.active()) return
      if (head && !await verifyHead(head, { slot: keys.slot, writer: keys.writer })) throw new Error('Invalid part head')
      if (!head) {
        invalidatePart(ctx, id)
        // Local bytes can repair a deletion even when has() still reports a local copy.
        await uploadListedParts(ctx, [part], false)
        if (ctx.active() && !ctx.state.parts[id]) pending++
        return
      }
      if (await ctx.adapter.has(id)) return
      const latest = await ctx.client.fetchLatestWithKeys(keys)
      if (!ctx.active()) return
      if (!latest) {
        invalidatePart(ctx, id)
        await uploadListedParts(ctx, [part], false)
        if (ctx.active() && !ctx.state.parts[id]) pending++
        return
      }
      if (latest.head.schema !== PART_SCHEMA) throw new Error('Unsupported part schema')
      await ctx.adapter.write(id, latest.plaintext)
      const hash = await sha256(latest.plaintext)
      const generation = await headHash(latest.head)
      if (ctx.active()) { ctx.state.parts = { ...ctx.state.parts, [id]: { seq: latest.head.seq, hash, headHash: generation } }; ctx.persist() }
    } catch {
      // Keep unavailable bytes pending; later restores retry without writing a placeholder.
      if (ctx.active()) pending++
    }
  })
  return pending
}
/** Validate the exact part generation, then re-check the main head immediately before deletion. */
export async function collectParts<S>(ctx: PartContext<S>, snapshot: S, main: EscrowHead): Promise<void> {
  const keep = new Set(listedParts(ctx.adapter, snapshot).map(p => p.id)), expected = await headHash(main)
  const observed = await ctx.client.getHead(main.slot)
  if (!ctx.active() || !observed || await headHash(observed) !== expected || ctx.canCollect && !ctx.canCollect()) return
  if (!observePartReferences(ctx, snapshot, main)) return
  for (const id of new Set([...Object.keys(ctx.state.parts), ...Object.keys(ctx.state.pendingDeletes ?? {})])) {
    if (!ctx.active() || keep.has(id)) continue
    if (ctx.canCollect && !ctx.canCollect()) return
    const entry = ctx.state.parts[id] ?? ctx.state.pendingDeletes?.[id]
    if (!entry) continue
    if (entry.unreferencedSince === undefined ||
      (ctx.now ?? Date.now)() - entry.unreferencedSince < (ctx.partGcGraceMs ?? DEFAULT_PART_GC_GRACE_MS)) continue
    ctx.collecting?.add(id)
    try {
      const keys = await derivePartKeys(ctx.app, ctx.code, id), head = await ctx.client.getHead(keys.slot)
      if (!ctx.active() || ctx.canCollect && !ctx.canCollect()) return
      if (head) {
        if (head.seq !== entry.seq || !await verifyHead(head, { slot: keys.slot, writer: keys.writer })) continue
        if (entry.headHash) { if (await headHash(head) !== entry.headHash) continue }
        else {
          // Older inventories recorded only a plaintext hash.
          const latest = await ctx.client.fetchLatestWithKeys(keys)
          if (!latest || await headHash(latest.head) !== await headHash(head) || await sha256(latest.plaintext) !== entry.hash) continue
        }
      }
      const current = await ctx.client.getHead(main.slot)
      // Only the acknowledged, parsed snapshot is trusted to describe references.
      // A different head defers collection until its references have been observed.
      if (!ctx.active() || !current || await headHash(current) !== expected ||
        ctx.canCollect && !ctx.canCollect() || (ctx.state.parts[id] ?? ctx.state.pendingDeletes?.[id]) !== entry) return
      ctx.state.pendingDeletes = { ...ctx.state.pendingDeletes, [id]: entry }
      delete ctx.state.parts[id]
      ctx.persist()
      if (!head || (await ctx.client.deleteWithKeys(keys, head)).type === 'deleted') {
        if (ctx.active() && ctx.state.pendingDeletes?.[id] === entry) { delete ctx.state.pendingDeletes[id]; ctx.persist() }
      }
    } catch { /* Retry uncertain deletions without trusting the uploaded inventory. */ }
    finally { ctx.collecting?.delete(id) }
  }
}
