import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVault } from './controller.js'
import type { VaultAdapter, VaultController } from './controller.js'
import { EscrowClient } from './core/client.js'
import { deriveEscrowKeys, derivePartKeys, utf8 } from './core/crypto.js'
import { headHash, stableStringify } from './core/head.js'
import { defaultSettings, loadAppState, saveSettings } from './settings.js'
import { MemoryProvider, memoryStorage } from './testing/memory.js'

type Data = { items: Record<string, { at: number; value: string }>; files: { id: string; size: number }[] }
const code = 'tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa', otherCode = 'tcv1-bbbbbbbbbbbbbbbbbbbbbbbbba', app = 'tc-vault-test'
const empty = (): Data => ({ items: {}, files: [] })
const instances: VaultController[] = [], clients: EscrowClient[] = []
function make(provider = new MemoryProvider(), storage = memoryStorage(), initial = empty()) {
  let data = initial
  const changes = new Set<() => void>(), files = new Map<string, Uint8Array>()
  const adapter: VaultAdapter<Data> = {
    app, schema: 'test/vault/1', snapshot: vi.fn(() => structuredClone(data)),
    parse(value) {
      if (typeof value !== 'object' || value === null || !('items' in value) || !('files' in value)) throw new Error('Invalid data')
      return value as Data
    },
    merge(local, remote) {
      const items = { ...remote.items }
      for (const [id, item] of Object.entries(local.items)) if (!items[id] || item.at >= items[id].at) items[id] = item
      return { items, files: [...new Map([...remote.files, ...local.files].map(f => [f.id, f])).values()] }
    },
    apply: vi.fn((next: Data) => { data = next; for (const cb of changes) cb() }),
    subscribe: cb => { changes.add(cb); return () => { changes.delete(cb) } },
  }
  const transport = vi.fn(() => provider)
  function start(partGcGraceMs?: number) {
    const controller = createVault({ adapter, transport, storage, partGcGraceMs }); instances.push(controller); return controller
  }
  return { adapter, storage, files, provider, transport, start, get data() { return data }, changes,
    change(next: Data) { data = next; for (const cb of changes) cb() } }
}
function settings(storage: Storage, activeCode = code) { saveSettings({ ...defaultSettings(), code: activeCode, mode: 'custom', room: 'vault' }, storage) }
async function seed(provider: MemoryProvider, data: Data, options = { seq: 1, parent: null as string | null }, activeCode = code) {
  const client = new EscrowClient(provider, 'vault'); clients.push(client)
  const result = await client.saveCheckpoint(app, activeCode, utf8(stableStringify(data)), { schema: 'test/vault/1', ...options })
  if (result.type !== 'ack') throw new Error('Seed failed: ' + result.type)
  return result
}
async function ready(controller: VaultController) {
  await vi.waitFor(() => expect(['upToDate', 'restored', 'saved']).toContain(controller.getView().status), { timeout: 5000 })
}
afterEach(() => { for (const v of instances.splice(0)) v.dispose(); for (const c of clients.splice(0)) c.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('controller lifecycle and CAS', () => {
  it('creates no transport while globally or individually disabled', async () => {
    const h = make(), v = h.start()
    expect(v.getView().status).toBe('off')
    h.change({ ...empty(), items: { a: { at: 1, value: 'a' } } }); await v.saveNow()
    expect(h.transport).not.toHaveBeenCalled(); expect(loadAppState(app, h.storage).dirty).toBe(true)
    v.setAppEnabled(false); v.enable(); await Promise.resolve()
    expect(h.transport).not.toHaveBeenCalled(); expect(v.revealCode()).toMatch(/^tcv1-/)
  })
  it('restores and merges before the first upload, suppressing apply save loops', async () => {
    const h = make(); settings(h.storage)
    await seed(h.provider, { ...empty(), items: { remote: { at: 2, value: 'r' } } })
    h.provider.requests.length = 0
    h.change({ ...empty(), items: { local: { at: 3, value: 'l' } } })
    const v = h.start(); await v.saveNow()
    expect(h.data.items).toEqual({ local: { at: 3, value: 'l' }, remote: { at: 2, value: 'r' } })
    const types = h.provider.requests.map(m => m.type)
    expect(types.indexOf('escrow_get')).toBeLessThan(types.indexOf('escrow_put'))
    expect(v.getView().lastSeq).toBe(2); expect(h.adapter.apply).toHaveBeenCalledTimes(1)
    expect(loadAppState(app, h.storage).dirty).toBe(false); expect(h.provider.failures).toEqual([])
  })
  it('merges a conflicting remote update and retries against its exact parent', async () => {
    const h = make(); settings(h.storage); const v = h.start(); await ready(v)
    h.change({ ...empty(), items: { local: { at: 3, value: 'l' } } })
    let inject = true
    h.provider.beforePut = async () => { if (inject) { inject = false; await seed(h.provider, { ...empty(), items: { concurrent: { at: 4, value: 'c' } } }) } }
    await v.saveNow()
    expect(v.getView().status).toBe('saved'); expect(v.getView().lastSeq).toBe(2)
    expect(Object.keys(h.data.items).sort()).toEqual(['concurrent', 'local'])
    const keys = await deriveEscrowKeys(app, code), remote = h.provider.heads.get(keys.slot)!
    const client = new EscrowClient(h.provider, 'vault'); clients.push(client)
    const latest = await client.fetchLatestWithKeys(keys)
    expect(JSON.parse(new TextDecoder().decode(latest!.plaintext))).toEqual(h.data)
    expect(remote.parent).not.toBeNull()
  })
  it('surfaces parse errors and never uploads before a successful restore', async () => {
    const h = make(); settings(h.storage); await seed(h.provider, empty())
    h.adapter.parse = () => { throw new Error('Rejected checkpoint') }
    h.provider.requests.length = 0
    const v = h.start(); await v.saveNow()
    expect(v.getView()).toMatchObject({ status: 'error', error: 'Rejected checkpoint' })
    expect(h.provider.requests.some(m => m.type === 'escrow_put')).toBe(false)
    h.adapter.parse = value => value as Data
    await v.restoreNow(); expect(v.getView().status).toBe('restored')
  })
  it('resets the sequence and parts on code switch without removing local data', async () => {
    const h = make(); settings(h.storage); const v = h.start(); await v.saveNow()
    expect(v.getView().lastSeq).toBe(1)
    h.change({ ...empty(), items: { local: { at: 1, value: 'keep' } } })
    expect(v.importCode('bad')).toBe(false)
    expect(v.importCode(otherCode)).toBe(true)
    expect(v.getView().lastSeq).toBe(0); expect(v.getView().parts.stored).toBe(0)
    await v.saveNow(); expect(v.getView().lastSeq).toBe(1); expect(h.data.items.local.value).toBe('keep')
    expect(h.provider.heads.size).toBe(2)
  })
  it('rejects invalid custom rooms and follows settings written by another app', async () => {
    const h = make(), v = h.start()
    expect(v.configure('custom', 'bad room')).toBe(false)
    settings(h.storage); await ready(v)
    expect(v.getView()).toMatchObject({ mode: 'custom', room: 'vault' })
    saveSettings({ ...defaultSettings(), code, mode: 'off' }, h.storage)
    expect(v.getView().status).toBe('off'); expect(h.provider.leave).toHaveBeenCalled()
  })
  it('preserves the new room lease when a previous code finishes joining late', async () => {
    const h = make(); settings(h.storage)
    let finish!: () => void, refs = 0
    const gate = new Promise<void>(resolve => { finish = resolve })
    h.provider.join.mockImplementation(async () => { refs++; await gate })
    h.provider.leave.mockImplementation(() => { refs-- })
    const send = h.provider.send.bind(h.provider)
    h.provider.send = (room, to, bytes) => { if (refs < 1) throw new Error('Room lease lost'); send(room, to, bytes) }
    const v = h.start()
    await vi.waitFor(() => expect(h.provider.join).toHaveBeenCalledTimes(1))
    v.importCode(otherCode)
    await vi.waitFor(() => expect(h.provider.join).toHaveBeenCalledTimes(2))
    finish(); await v.saveNow()
    expect(v.getView().status).toBe('saved'); expect(refs).toBe(1)
    v.dispose(); expect(refs).toBe(0)
  })
})

describe('controller scheduling', () => {
  it('debounces changes for eight seconds and persists the dirty flag', async () => {
    const h = make(); settings(h.storage); const v = h.start(); await v.saveNow()
    vi.useFakeTimers()
    h.change({ ...empty(), items: { a: { at: 1, value: 'first' } } })
    await vi.advanceTimersByTimeAsync(7000)
    h.change({ ...empty(), items: { a: { at: 2, value: 'second' } } })
    await vi.advanceTimersByTimeAsync(7999)
    expect(v.getView().lastSeq).toBe(1); expect(loadAppState(app, h.storage).dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(1); await vi.waitFor(() => expect(v.getView().lastSeq).toBe(2))
    expect(loadAppState(app, h.storage).dirty).toBe(false)
  })
  it('saves within sixty seconds of continuous edits and clears timers on dispose', async () => {
    const h = make(); settings(h.storage); const v = h.start(); await v.saveNow(); vi.useFakeTimers()
    for (let i = 0; i < 12; i++) {
      h.change({ ...empty(), items: { a: { at: i, value: String(i) } } }); await vi.advanceTimersByTimeAsync(5000)
    }
    await vi.waitFor(() => expect(v.getView().lastSeq).toBe(2))
    v.dispose(); expect(vi.getTimerCount()).toBe(0); expect(h.changes.size).toBe(0)
  })
  it('waits twenty seconds for providers and resumes when one appears', async () => {
    const h = make(); settings(h.storage); h.provider.online = false; const v = h.start()
    await vi.waitFor(() => expect(h.provider.join).toHaveBeenCalled())
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(20000)
    // The existing provider deadline uses the real clock; a second session installs a controlled deadline.
    v.disable(); h.provider.online = false; v.configure('custom', 'vault')
    await vi.waitFor(() => expect(h.provider.join).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(20000)
    expect(v.getView().status).toBe('noProvider')
    h.provider.online = true; h.provider.advertise(); await vi.waitFor(() => expect(v.getView().status).toBe('upToDate'))
    await v.saveNow(); expect(v.getView().status).toBe('saved')
  })
  it('flushes on hidden/pagehide and disposes event listeners', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }), win = new EventTarget()
    vi.stubGlobal('document', doc); vi.stubGlobal('window', win)
    const h = make(); settings(h.storage); const v = h.start(); await v.saveNow()
    h.change({ ...empty(), items: { a: { at: 1, value: 'a' } } })
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(v.getView().lastSeq).toBe(2))
    h.change({ ...empty(), items: { a: { at: 2, value: 'b' } } }); win.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => expect(v.getView().lastSeq).toBe(3))
    v.dispose(); const calls = h.provider.requests.length; win.dispatchEvent(new Event('pagehide')); expect(h.provider.requests).toHaveLength(calls)
  })
  it('limits conflicts to three attempts and retries after the sixty-second backoff', async () => {
    const h = make(); settings(h.storage); const v = h.start(); await v.saveNow()
    h.change({ ...empty(), items: { a: { at: 1, value: 'a' } } })
    const original = h.provider.answer.bind(h.provider)
    let conflicts = 0, rejecting = true
    h.provider.answer = async (room, m) => {
      if (rejecting && m.type === 'escrow_put') {
        conflicts++; h.provider.reply(room, { v: 1, type: 'escrow_error', id: m.id, code: 'conflict', message: 'Changed', head: h.provider.heads.get(m.head.slot) ?? null })
      } else await original(room, m)
    }
    vi.useFakeTimers(); await v.saveNow()
    expect(conflicts).toBe(3); expect(v.getView().status).toBe('error'); expect(loadAppState(app, h.storage).dirty).toBe(true)
    rejecting = false
    await vi.advanceTimersByTimeAsync(60000)
    await vi.waitFor(() => expect(v.getView().lastSeq).toBe(2))
    expect(v.getView().status).toBe('saved')
  })
  it('keeps edits made during an upload dirty and saves them on the next pass', async () => {
    const h = make(); settings(h.storage); const v = h.start(); await v.saveNow()
    h.change({ ...empty(), items: { a: { at: 1, value: 'first' } } })
    let changed = false
    h.provider.beforePut = async () => {
      if (!changed) { changed = true; h.change({ ...empty(), items: { a: { at: 2, value: 'second' } } }) }
    }
    await v.saveNow(); expect(loadAppState(app, h.storage).dirty).toBe(true)
    await v.saveNow(); expect(loadAppState(app, h.storage).dirty).toBe(false); expect(v.getView().lastSeq).toBe(3)
  })
  it('clears request and download deadlines when disposed during a stalled restore', async () => {
    const h = make(); settings(h.storage); await seed(h.provider, empty())
    h.provider.storageGet.mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    const v = h.start()
    await vi.waitFor(() => expect(h.provider.storageGet).toHaveBeenCalled())
    v.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it('uses one browser lock per app, follows the writer, and restores before a lock handoff save', async () => {
    const pending: { callback: () => Promise<void>; signal: AbortSignal; reject(e: unknown): void }[] = []
    let locked = false
    const pump = () => {
      if (locked || !pending.length) return
      const task = pending.shift()!
      if (task.signal.aborted) { task.reject(new Error('Aborted')); pump(); return }
      locked = true
      void task.callback().finally(() => { locked = false; pump() })
    }
    const request = vi.fn((_name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) => new Promise<void>((resolve, reject) => {
      pending.push({ callback: async () => { await callback(); resolve() }, signal: options.signal, reject }); pump()
      options.signal.addEventListener('abort', () => { if (!locked) pump() })
    }))
    vi.stubGlobal('navigator', { locks: { request } })
    const provider = new MemoryProvider(), storage = memoryStorage(), a = make(provider, storage), b = make(provider, storage)
    settings(storage)
    const writer = a.start(); await writer.saveNow()
    const follower = b.start(); await ready(follower)
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[0][0]).toBe('tc-vault:' + app)
    b.change({ ...empty(), items: { follower: { at: 2, value: 'f' } } })
    const seq = follower.getView().lastSeq
    await follower.saveNow(); expect(follower.getView().lastSeq).toBe(seq)
    a.change({ ...empty(), items: { writer: { at: 3, value: 'w' } } }); await writer.saveNow()
    await vi.waitFor(() => expect(b.data.items.writer).toBeDefined())
    expect(b.data.items.follower).toBeDefined()
    const applied = vi.mocked(b.adapter.apply).mock.calls.length
    writer.dispose()
    await vi.waitFor(() => expect(vi.mocked(b.adapter.apply).mock.calls.length).toBeGreaterThan(applied))
    await follower.saveNow(); expect(follower.getView().lastSeq).toBe(3)
    expect(b.data.items).toHaveProperty('writer'); expect(b.data.items).toHaveProperty('follower')
  })
})

describe('controller attachments', () => {
  function withParts() {
    const h = make()
    h.adapter.parts = { list: state => state.files, read: async id => h.files.get(id) ?? null,
      has: async id => h.files.has(id), write: vi.fn(async (id, bytes) => { h.files.set(id, bytes) }), maxBytes: 8 }
    return h
  }
  it('uploads before the main head, skips unchanged content, updates changed parts and records omissions', async () => {
    const h = withParts(); settings(h.storage); h.files.set('f:a', utf8('one')); h.files.set('large', new Uint8Array(9))
    h.change({ ...empty(), files: [{ id: 'f:a', size: 3 }, { id: 'large', size: 9 }, { id: 'missing', size: 1 }] })
    const v = h.start(); await v.saveNow()
    expect(v.getView().parts).toEqual({ stored: 1, pending: 0, omitted: 2 })
    const keys = await derivePartKeys(app, code, 'f:a'), puts = h.provider.requests.filter(m => m.type === 'escrow_put')
    expect(puts[0].head.slot).toBe(keys.slot)
    expect(h.provider.heads.get(keys.slot)?.seq).toBe(1)
    h.change(h.data); await v.saveNow(); expect(h.provider.heads.get(keys.slot)?.seq).toBe(1)
    h.files.set('f:a', utf8('two')); h.change(h.data); await v.saveNow(); expect(h.provider.heads.get(keys.slot)?.seq).toBe(2)
  })
  it('fetches missing parts during restore and omits quota failures', async () => {
    const h = withParts(); settings(h.storage); h.files.set('f:a', utf8('one'))
    h.change({ ...empty(), files: [{ id: 'f:a', size: 3 }, { id: 'f:b', size: 3 }] }); h.files.set('f:b', utf8('two'))
    const quota = await derivePartKeys(app, code, 'f:b'); h.provider.quota.add(quota.slot)
    const v = h.start(); await v.saveNow(); expect(v.getView().parts.omitted).toBe(1)
    v.dispose(); h.files.clear()
    const target = withParts(); settings(target.storage)
    const receiver = createVault({ adapter: target.adapter, transport: h.provider, storage: target.storage }); instances.push(receiver)
    await receiver.restoreNow(); expect(target.files.get('f:a')).toEqual(utf8('one')); expect(target.adapter.parts!.write).toHaveBeenCalledTimes(1)
  })
  it('collects unreferenced slots after ACK and recreates deleted parts with their successor sequence', async () => {
    const h = withParts(); settings(h.storage); h.files.set('f:a', utf8('one'))
    h.change({ ...empty(), files: [{ id: 'f:a', size: 3 }] }); const v = h.start(0); await v.saveNow()
    const keys = await derivePartKeys(app, code, 'f:a')
    h.change(empty()); await v.saveNow()
    await vi.waitFor(() => expect(h.provider.heads.has(keys.slot)).toBe(false))
    expect(loadAppState(app, h.storage).parts).toEqual({})
    h.change({ ...empty(), files: [{ id: 'f:a', size: 3 }] }); await v.saveNow()
    expect(v.getView().status).toBe('saved'); expect(h.provider.heads.get(keys.slot)?.seq).toBe(2)
  })
  it('does not collect attachments if the acknowledged main head has moved', async () => {
    const h = withParts(); settings(h.storage); h.files.set('f:a', utf8('one'))
    const referenced = { ...empty(), files: [{ id: 'f:a', size: 3 }] }
    h.change(referenced); const v = h.start(); await v.saveNow()
    const keys = await deriveEscrowKeys(app, code), part = await derivePartKeys(app, code, 'f:a')
    const originalReply = h.provider.reply.bind(h.provider)
    let changed = false
    h.provider.reply = (room, message) => {
      originalReply(room, message)
      if (!changed && message.type === 'escrow_ack' && message.slot === keys.slot && message.seq === 2) {
        changed = true
        const current = h.provider.heads.get(keys.slot)!
        // A moved signed head will be visible before collection's asynchronous re-check.
        const next = { ...current, seq: 3 }
        h.provider.heads.set(keys.slot, next)
      }
    }
    h.change(empty()); await v.saveNow(); await new Promise(resolve => setTimeout(resolve, 80))
    expect(h.provider.heads.has(part.slot)).toBe(true)
    expect(h.provider.requests.some(m => m.type === 'escrow_delete')).toBe(false)
  })
  it('retains failed collections and retries them on a later visible poll', async () => {
    const h = withParts(); settings(h.storage); h.files.set('f:a', utf8('one'))
    h.change({ ...empty(), files: [{ id: 'f:a', size: 3 }] })
    vi.useFakeTimers()
    const v = h.start(0); await v.saveNow()
    const key = await derivePartKeys(app, code, 'f:a'), original = h.provider.answer.bind(h.provider)
    let rejecting = true
    h.provider.answer = async (room, m) => {
      if (m.type === 'escrow_delete' && rejecting) h.provider.reply(room, { v: 1, type: 'escrow_error', id: m.id, code: 'busy', message: 'Try later' })
      else await original(room, m)
    }
    h.change(empty()); await v.saveNow()
    await vi.waitFor(() => expect(h.provider.requests.some(m => m.type === 'escrow_delete')).toBe(true))
    expect(loadAppState(app, h.storage).parts['f:a']).toBeUndefined()
    expect(loadAppState(app, h.storage).pendingDeletes?.['f:a']).toBeDefined(); expect(h.provider.heads.has(key.slot)).toBe(true)
    rejecting = false; await vi.advanceTimersByTimeAsync(60000)
    await vi.waitFor(() => expect(h.provider.heads.has(key.slot)).toBe(false))
    expect(loadAppState(app, h.storage).parts).toEqual({})
  })
  it('lets saves proceed while collection is stalled and preserves a newly re-referenced part', async () => {
    const h = withParts(); settings(h.storage); h.files.set('f:a', utf8('one'))
    const referenced = { ...empty(), files: [{ id: 'f:a', size: 3 }] }
    h.change(referenced); const v = h.start(0); await v.saveNow()
    const key = await derivePartKeys(app, code, 'f:a'), original = h.provider.answer.bind(h.provider)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    h.provider.answer = async (room, m) => { if (m.type === 'escrow_delete') await gate; await original(room, m) }
    h.change(empty()); await v.saveNow()
    await vi.waitFor(() => expect(h.provider.requests.some(m => m.type === 'escrow_delete')).toBe(true))
    h.change(referenced); await v.saveNow()
    expect(v.getView().lastSeq).toBe(3); expect(h.provider.heads.get(key.slot)?.seq).toBe(2)
    release()
    await vi.waitFor(() => expect(h.provider.failures).toEqual([]))
    expect(h.provider.heads.has(key.slot)).toBe(true)
    expect(loadAppState(app, h.storage).parts['f:a'].seq).toBe(2)
  })
})
