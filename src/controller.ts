import { EscrowClient } from './core/client.js'
import type { EscrowTransport } from './core/client.js'
import { deriveAutoRoom, deriveEscrowKeys, utf8 } from './core/crypto.js'
import type { EscrowKeys } from './core/crypto.js'
import { headHash, stableStringify } from './core/head.js'
import type { EscrowHead } from './core/head.js'
import { generateVaultCode, parseVaultCode } from './code.js'
import { browserStorage, defaultAppState, loadAppState, loadSettings, saveAppState, saveSettings, subscribeSettings, validVaultRoom } from './settings.js'
import type { VaultAppState, VaultMode, VaultSettings } from './settings.js'
import { collectParts, fetchParts, listedParts, observePartReferences, uploadParts } from './parts.js'
import type { PartContext, VaultParts } from './parts.js'

export interface VaultAdapter<S> {
  app: string; schema: string
  snapshot(): S | Promise<S>
  parse(value: unknown): S
  merge(local: S, remote: S): S
  apply(next: S): void | Promise<void>
  subscribe(onChange: () => void): () => void
  parts?: VaultParts<S>
}
export interface VaultView {
  mode: VaultMode; appEnabled: boolean; room: string; autoRoom: string; hasCode: boolean
  status: 'off' | 'searching' | 'noProvider' | 'restoring' | 'saving' | 'saved' | 'restored' | 'upToDate' | 'error'
  error?: string; savedAt: number; restoredAt: number; lastSeq: number
  parts: { stored: number; pending: number; omitted: number }
  hasParts?: boolean
}
export interface VaultController {
  getView(): VaultView
  subscribe(cb: (view: VaultView) => void): () => void
  enable(): void; disable(): void
  setAppEnabled(on: boolean): void
  configure(mode: VaultMode, room?: string): boolean
  importCode(code: string): boolean
  revealCode(): string | null
  saveNow(): Promise<void>; restoreNow(): Promise<void>
  dispose(): void
}
export interface VaultOptions<S> {
  adapter: VaultAdapter<S>; transport: EscrowTransport | (() => EscrowTransport)
  storage?: Storage; now?: () => number
  /** Minimum observed time without main references before collecting a part. Defaults to 24 hours. */
  partGcGraceMs?: number
}
type Timer = ReturnType<typeof setTimeout>
/** Isolates a session's lease from late join completion in an older session. */
function sessionTransport(source: EscrowTransport): EscrowTransport {
  const rooms = new Set<string>()
  return {
    join(room) { rooms.add(room); return source.join(room) },
    leave(room) { if (rooms.delete(room)) source.leave(room) },
    send: (room, to, bytes) => source.send(room, to, bytes),
    onMessage: (room, cb) => source.onMessage(room, cb), onPeer: (room, cb) => source.onPeer(room, cb),
    storageAdd: (name, bytes) => source.storageAdd(name, bytes), storageGet: cid => source.storageGet(cid),
  }
}
interface Session {
  code: string; client?: EscrowClient; keys?: EscrowKeys; initialized: boolean; applying: boolean
  writer: boolean; lockAbort: AbortController; release?: () => void
  saving: boolean; collecting: Set<string>
  queue: Promise<void>; off?: () => void; poll?: ReturnType<typeof setInterval>
  trailing?: Timer; maximum?: Timer; retry?: Timer; gc?: Promise<void>
  collect?: () => void
  reconnect?: Timer; reconnectDelay: number
}
export function createVault<S>(o: VaultOptions<S>): VaultController {
  const { adapter } = o, storage = o.storage ?? browserStorage(), now = o.now ?? Date.now
  if (!adapter.app || !adapter.schema) throw new Error('Vault app and schema are required')
  if (o.partGcGraceMs !== undefined && (!Number.isFinite(o.partGcGraceMs) || o.partGcGraceMs < 0)) throw new Error('Invalid part GC grace')
  let settings = loadSettings(storage), state = loadAppState(adapter.app, storage)
  let disposed = false, writing = false, session: Session | undefined, revision = 0, autoRoom = ''
  let status: VaultView['status'] = 'off', error: string | undefined, pendingParts = 0
  const listeners = new Set<(view: VaultView) => void>()
  const getView = (): VaultView => ({ mode: settings.mode, appEnabled: state.enabled,
    room: settings.mode === 'auto' ? autoRoom : settings.mode === 'custom' ? settings.room : '', autoRoom,
    hasCode: !!settings.code, status, ...(error ? { error } : {}), savedAt: state.savedAt,
    restoredAt: state.restoredAt, lastSeq: state.lastSeq,
    hasParts: !!adapter.parts, parts: { stored: Object.keys(state.parts).length, pending: pendingParts, omitted: state.omitted.length } })
  const emit = () => { if (!disposed) for (const cb of listeners) { try { cb(getView()) } catch { /* Subscribers are isolated. */ } } }
  const update = (next: VaultView['status'], message?: string) => { status = next; error = message; emit() }
  const active = (s: Session) => !disposed && session === s
  const sharedState = () => {
    const shared = loadAppState(adapter.app, storage)
    return shared.scope === state.scope ? shared : undefined
  }
  const refreshDirty = () => {
    const shared = sharedState()
    if (!shared) return
    if ((shared.editVersion ?? 0) >= (state.editVersion ?? 0)) {
      if (shared.editToken === state.editToken || (shared.editVersion ?? 0) > (state.editVersion ?? 0)) state.dirty = shared.dirty
      else state.dirty ||= shared.dirty
      state.editVersion = shared.editVersion; state.editToken = shared.editToken
    }
  }
  type EditStamp = { version: number; token?: string }
  const stamp = (): EditStamp => ({ version: state.editVersion ?? 0, token: state.editToken })
  const persist = (clear?: EditStamp) => {
    const shared = sharedState()
    if (shared) {
      const unchanged = clear !== undefined && (shared.editVersion ?? 0) === clear.version && shared.editToken === clear.token
      if (!clear || !unchanged) state.dirty ||= shared.dirty
      if ((shared.editVersion ?? 0) > (state.editVersion ?? 0) ||
        (shared.editVersion ?? 0) === (state.editVersion ?? 0) && shared.editToken !== clear?.token) {
        state.editVersion = shared.editVersion; state.editToken = shared.editToken
      }
      // A follower publishes edits without overwriting the writer's inventory.
      if (session && !session.writer && shared.lastSeq >= state.lastSeq) {
        state.lastSeq = shared.lastSeq; state.lastHash = shared.lastHash; state.parts = shared.parts
        state.pendingDeletes = shared.pendingDeletes; state.savedAt = shared.savedAt
        state.partsObservedSeq = shared.partsObservedSeq
      }
    }
    writing = true
    try { saveAppState(adapter.app, state, storage) } finally { writing = false }
    emit()
  }
  const markDirty = () => {
    refreshDirty()
    state.editVersion = Math.min(Number.MAX_SAFE_INTEGER, (state.editVersion ?? 0) + 1)
    state.editToken = crypto.randomUUID(); state.dirty = true; persist()
  }
  const clearWrites = (s: Session) => {
    clearTimeout(s.trailing); clearTimeout(s.maximum); s.trailing = s.maximum = undefined
  }
  const stop = () => {
    const old = session; session = undefined; pendingParts = 0
    if (!old) return
    clearWrites(old); clearTimeout(old.retry); clearTimeout(old.reconnect); clearInterval(old.poll)
    old.off?.(); old.lockAbort.abort(); old.release?.(); old.client?.dispose()
  }
  const fail = (s: Session, e: unknown) => {
    if (!active(s)) return
    clearWrites(s)
    update('error', e instanceof Error ? e.message : String(e))
    if (!s.client?.providers.size) reconnect(s)
    clearTimeout(s.retry)
    s.retry = setTimeout(() => { s.retry = undefined; void enqueue(s, async () => { await restore(s); if (state.dirty) await save(s) }) }, 60000)
  }
  function enqueue(s: Session, work: () => Promise<void>): Promise<void> {
    const next = s.queue.then(async () => { if (active(s)) await work() }).catch(e => fail(s, e))
    s.queue = next
    return next
  }
  function schedule(s: Session) {
    if (!active(s) || !s.writer) return
    clearTimeout(s.trailing)
    s.trailing = setTimeout(() => { void enqueue(s, () => save(s)) }, 8000)
    s.maximum ??= setTimeout(() => { void enqueue(s, () => save(s)) }, 60000)
  }
  function changed() {
    if (disposed || session?.applying) return
    revision++; markDirty()
    if (session) schedule(session)
  }
  function partContext(s: Session): PartContext<S> {
    return { adapter: adapter.parts!, app: adapter.app, code: s.code, client: s.client!, state,
      active: () => active(s), persist: () => { if (active(s)) persist() }, collecting: s.collecting,
      canCollect: () => !s.saving && s.writer, now, partGcGraceMs: o.partGcGraceMs }
  }
  async function apply(s: Session, value: S) {
    if (!active(s)) return
    let pending: void | Promise<void>
    s.applying = true
    try { pending = adapter.apply(value) } finally { s.applying = false }
    await pending
  }
  async function restore(s: Session, force = false): Promise<void> {
    if (!active(s) || !s.client || !s.keys) return
    refreshDirty()
    if (!s.client.providers.size) { update('noProvider'); reconnect(s); return }
    update('restoring')
    const head = await s.client.getHead(s.keys.slot)
    if (!active(s)) return
    let snapshot: S | undefined
    if (head && (head.seq > state.lastSeq || force)) {
      const latest = await s.client.fetchLatestWithKeys(s.keys)
      if (!active(s)) return
      if (!latest) throw new Error('Vault head disappeared during restore')
      if (latest.head.schema !== adapter.schema) throw new Error('Unsupported vault schema')
      const remote = adapter.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(latest.plaintext)))
      const hash = await headHash(latest.head)
      if (!active(s)) return
      if (adapter.parts) observePartReferences(partContext(s), remote, latest.head)
      s.collect = () => gc(s, remote, latest.head)
      let applied = false
      for (let attempt = 0; attempt < 4; attempt++) {
        refreshDirty()
        const generation = revision, edits = stamp(), local = await adapter.snapshot()
        if (!active(s)) return
        snapshot = adapter.merge(local, remote)
        refreshDirty()
        if (generation !== revision || edits.version !== (state.editVersion ?? 0) || edits.token !== state.editToken) continue
        await apply(s, snapshot)
        applied = true; break
      }
      if (!applied) { markDirty(); throw new Error('Local edits changed during restore; retrying later') }
      if (!active(s)) return
      const after = await adapter.snapshot()
      if (!active(s)) return
      state.lastSeq = latest.head.seq; state.lastHash = hash; state.restoredAt = now()
      if (stableStringify(after) !== stableStringify(snapshot) || stableStringify(after) !== stableStringify(remote)) markDirty()
      snapshot = after
      persist(); update('restored')
    } else {
      if (!head) { state.lastSeq = 0; state.lastHash = null; markDirty() }
      update('upToDate')
    }
    s.initialized = true
    if (adapter.parts) {
      snapshot ??= await adapter.snapshot()
      if (!active(s)) return
      const ctx = partContext(s)
      pendingParts = listedParts(adapter.parts, snapshot).length; emit()
      const remaining = await fetchParts(ctx, snapshot)
      if (active(s)) { pendingParts = remaining; emit() }
    }
    if (active(s)) { persist(); if (state.dirty && !s.saving) schedule(s) }
  }
  function gc(s: Session, snapshot: S, head: EscrowHead) {
    s.collect = () => gc(s, snapshot, head)
    if (!adapter.parts || s.gc || !active(s) || !s.writer) return
    s.gc = collectParts(partContext(s), snapshot, head).catch(() => {}).finally(() => { s.gc = undefined })
  }
  async function save(s: Session): Promise<void> {
    clearWrites(s)
    refreshDirty()
    if (!active(s) || !s.writer || !s.client || !s.keys) return
    if (!s.initialized) await restore(s)
    if (!active(s) || !s.initialized) return
    if (!s.client.providers.size) { update('noProvider'); reconnect(s); return }
    clearWrites(s)
    s.saving = true
    try {
    if (!state.dirty) {
      if (adapter.parts) {
        const snapshot = await adapter.snapshot()
        if (active(s)) await uploadParts(partContext(s), snapshot)
      }
      return
    }
    for (let attempt = 0; attempt < 3 && active(s); attempt++) {
      update('saving')
      refreshDirty()
      const atRevision = revision, edits = stamp(), snapshot = await adapter.snapshot()
      if (!active(s)) return
      if (adapter.parts) {
        pendingParts = listedParts(adapter.parts, snapshot).length; emit()
        try { await uploadParts(partContext(s), snapshot) } finally { if (active(s)) { pendingParts = 0; emit() } }
      }
      if (!active(s)) return
      const bytes = utf8(stableStringify(snapshot))
      const result = await s.client.saveWithKeys(s.keys, bytes, { schema: adapter.schema, parent: state.lastHash, seq: state.lastSeq + 1 })
      if (!active(s)) return
      if (result.type === 'ack') {
        if (adapter.parts) observePartReferences(partContext(s), snapshot, result.head)
        // A delayed deletion may land while the main PUT is in flight.
        // The pre-PUT upload already advanced any generation being collected.
        if (adapter.parts) await uploadParts({ ...partContext(s), collecting: undefined }, snapshot)
        if (!active(s)) return
        const after = await adapter.snapshot()
        if (!active(s)) return
        refreshDirty()
        state.lastSeq = result.seq; state.lastHash = result.hash; state.savedAt = now()
        state.dirty = revision !== atRevision || edits.version !== (state.editVersion ?? 0) || edits.token !== state.editToken ||
          stableStringify(after) !== stableStringify(snapshot)
        persist(edits); update('saved'); s.saving = false; gc(s, snapshot, result.head)
        if (state.dirty) schedule(s)
        return
      }
      if (result.type === 'error') throw new Error(result.code + ': ' + result.message)
      if (attempt === 2) throw new Error('Vault conflict retry limit reached')
      await restore(s, true)
    }
    } finally { s.saving = false }
  }
  function reconnect(s: Session, immediate = false) {
    if (!active(s) || !s.client || s.client.providers.size || s.reconnect && !immediate) return
    clearTimeout(s.reconnect)
    s.reconnect = setTimeout(() => {
      s.reconnect = undefined
      if (!active(s)) return
      if (globalThis.document?.visibilityState === 'hidden') { reconnect(s); return }
      void enqueue(s, async () => {
        try {
          await s.client!.join(true)
          if (!active(s)) return
          if (s.client!.providers.size) {
            s.reconnectDelay = 5000
            await restore(s); refreshDirty(); if (state.dirty) await save(s)
          } else { update('noProvider'); reconnect(s) }
        } catch (e) { fail(s, e) }
      })
      s.reconnectDelay = Math.min(60000, s.reconnectDelay * 2)
    }, immediate ? 0 : s.reconnectDelay)
  }
  function start() {
    stop(); autoRoom = ''
    if (disposed || settings.mode === 'off' || !state.enabled || !settings.code) { update('off'); return }
    const s: Session = { code: settings.code, initialized: false, applying: false, writer: false,
      saving: false, collecting: new Set(), reconnectDelay: 5000, lockAbort: new AbortController(), queue: Promise.resolve() }
    session = s; update('searching')
    void enqueue(s, async () => {
      const [keys, room] = await Promise.all([deriveEscrowKeys(adapter.app, s.code), deriveAutoRoom('tc-vault', s.code)])
      if (!active(s)) return
      s.keys = keys; autoRoom = room
      const effectiveRoom = settings.mode === 'custom' ? settings.room : room
      const scope = keys.slot + '\n' + effectiveRoom
      if (state.scope !== scope) {
        const shared = loadAppState(adapter.app, storage)
        state = shared.scope === scope ? shared : { ...defaultAppState(), enabled: state.enabled,
          dirty: true, scope, editVersion: shared.editVersion, editToken: shared.editToken }
        revision++; persist()
      }
      s.client = new EscrowClient(sessionTransport(typeof o.transport === 'function' ? o.transport() : o.transport),
        effectiveRoom)
      s.off = s.client.onProvider(() => {
        if (!active(s)) return
        if (!s.client!.providers.size) { update('noProvider'); reconnect(s); return }
        clearTimeout(s.reconnect); s.reconnect = undefined; s.reconnectDelay = 5000
        if (active(s) && (status === 'noProvider' || status === 'error' && !s.initialized)) void enqueue(s, async () => {
          await restore(s); if (state.dirty) schedule(s)
        })
      })
      const locks = globalThis.navigator?.locks
      if (locks) {
        void locks.request('tc-vault:' + adapter.app, { signal: s.lockAbort.signal }, async () => {
          if (!active(s)) return
          const held = new Promise<void>(resolve => { s.release = resolve })
          if (!s.initialized) s.writer = true
          else void enqueue(s, async () => {
            await restore(s, true)
            if (active(s)) { s.writer = true; if (state.dirty) schedule(s) }
          })
          await held
          s.writer = false
        }).catch(e => { if (active(s) && !s.lockAbort.signal.aborted) fail(s, e) })
      } else s.writer = true
      emit()
      s.poll = setInterval(() => {
        if (globalThis.document?.visibilityState === 'hidden') return
        void enqueue(s, async () => {
          refreshDirty()
          await restore(s)
          if (state.dirty && !s.retry) await save(s)
          if (active(s)) s.collect?.()
        })
      }, 60000)
      if (!await s.client.waitForProvider(20000)) { if (active(s)) update('noProvider') }
      else if (active(s)) await restore(s)
      if (!active(s)) return
      if (!s.client.providers.size) reconnect(s)
    })
  }
  function readSettings() {
    if (disposed || writing) return
    const next = loadSettings(storage), app = loadAppState(adapter.app, storage), old = settings
    const codeChanged = next.code !== old.code, enableChanged = app.enabled !== state.enabled
    settings = next
    if (codeChanged) { state = { ...defaultAppState(), enabled: app.enabled, dirty: state.dirty }; revision++; persist() }
    else state.enabled = app.enabled
    refreshDirty()
    if (codeChanged || enableChanged || next.mode !== old.mode || next.room !== old.room) start()
    else {
      emit()
      if (session && !session.writer && (app.lastSeq > state.lastSeq || app.lastHash !== state.lastHash)) {
        const s = session
        void enqueue(s, () => restore(s))
      }
    }
  }
  const offSettings = subscribeSettings(readSettings, storage, globalThis.window, adapter.app)
  const offChanges = adapter.subscribe(changed)
  const flush = () => { refreshDirty(); if (session && state.dirty) void enqueue(session, () => save(session!)) }
  const online = () => { if (session) reconnect(session, true) }
  const visibility = () => { if (globalThis.document?.visibilityState === 'hidden') flush(); else online() }
  globalThis.document?.addEventListener('visibilitychange', visibility)
  globalThis.window?.addEventListener('pagehide', flush)
  globalThis.window?.addEventListener('online', online)
  function configure(mode: VaultMode, room = ''): boolean {
    if (disposed || !['auto', 'custom', 'off'].includes(mode) || mode === 'custom' && !validVaultRoom(room)) return false
    const next = { ...settings, mode, room: mode === 'custom' ? room : '', code: settings.code || (mode !== 'off' ? generateVaultCode() : '') }
    writing = true
    try { saveSettings(next, storage) } finally { writing = false }
    // Keep working in memory if persistence is unavailable.
    const oldCode = settings.code
    settings = next
    if (oldCode !== next.code) { state = { ...defaultAppState(), enabled: state.enabled, dirty: state.dirty }; persist() }
    start(); return true
  }
  start()
  return {
    getView, subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    enable: () => { configure('auto') }, disable: () => { configure('off') }, configure,
    setAppEnabled(on) { if (!disposed) { state.enabled = on; persist(); start() } },
    importCode(input) {
      const code = parseVaultCode(input)
      if (!code || disposed) return false
      if (code === settings.code) return true
      const next: VaultSettings = { ...settings, code }
      writing = true
      try { saveSettings(next, storage) } finally { writing = false }
      settings = next; state = { ...defaultAppState(), enabled: state.enabled, dirty: state.dirty }; revision++; persist(); start(); return true
    },
    revealCode: () => settings.code || null,
    saveNow: () => session ? enqueue(session, () => save(session!)) : Promise.resolve(),
    restoreNow: () => session ? enqueue(session, () => restore(session!, true)) : Promise.resolve(),
    dispose() {
      if (disposed) return
      disposed = true; stop(); offSettings(); offChanges(); listeners.clear()
      globalThis.document?.removeEventListener('visibilitychange', visibility)
      globalThis.window?.removeEventListener('pagehide', flush)
      globalThis.window?.removeEventListener('online', online)
    },
  }
}
