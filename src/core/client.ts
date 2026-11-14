import { DEFAULT_MAX_PLAINTEXT, decryptBlob, deriveEscrowKeys, encryptBlob, gunzip, gzip, sha256, supportsGzip } from './crypto.js'
import { buildHead, DEFAULT_MAX_BLOB, headHash, parseHead, safeInt, SLOT_RE, signDelete, verifyHead } from './head.js'
import type { EscrowKeys } from './crypto.js'
import type { EscrowHead } from './head.js'
import { encodeEscrowMessage, parseEscrowMessage } from './protocol.js'
import type { EscrowAck, EscrowDelete, EscrowErrorCode, EscrowGet, EscrowMessage, EscrowPut } from './protocol.js'

export type Unsubscribe = () => void
export interface EscrowTransport {
  join(room: string): Promise<void>
  leave(room: string): void
  send(room: string, toId: string | null, bytes: Uint8Array): void
  onMessage(room: string, cb: (fromId: string, bytes: Uint8Array) => void): Unsubscribe
  onPeer(room: string, cb: (id: string, joined: boolean) => void): Unsubscribe
  storageAdd(name: string, bytes: Uint8Array): Promise<string>
  storageGet(cid: string): Promise<Uint8Array>
}
export type ClientErrorCode = EscrowErrorCode | 'timeout' | 'closed' | 'transport'
export class EscrowRequestError extends Error {
  readonly code: ClientErrorCode
  constructor(code: ClientErrorCode, message: string) { super(message); this.name = 'EscrowRequestError'; this.code = code }
}
export type PutResult =
  | { type: 'ack'; slot: string; seq: number; hash: string; head: EscrowHead }
  | { type: 'conflict'; head: EscrowHead | null }
  | { type: 'error'; code: ClientErrorCode; message: string; head?: EscrowHead }
export type DeleteResult =
  | { type: 'deleted' }
  | { type: 'conflict'; head: EscrowHead | null }
  | { type: 'error'; code: ClientErrorCode; message: string; head?: EscrowHead }
  | { type: 'unsupported'; message: string }
export interface EscrowClientOptions {
  maxBlob?: number
  maxPlaintext?: number
  getTimeoutMs?: number
  putTimeoutMs?: number
}
export interface CheckpointOptions {
  schema: string
  parent: string | null
  seq: number
  comp?: 'gzip' | 'none'
  timeoutMs?: number
  signal?: AbortSignal
}
interface Pending {
  message: EscrowGet | EscrowPut | EscrowDelete
  writer?: string
  expectedHash?: string
  target?: string
  pinnedTarget?: string
  timer: ReturnType<typeof setTimeout>
  finish(value: EscrowHead | null | PutResult | DeleteResult, error?: EscrowRequestError): void
}
/** One handle owns one escrow room. Requests lazily join and discover providers. */
export class EscrowClient {
  readonly room: string
  private readonly transport: EscrowTransport
  private readonly options: Required<EscrowClientOptions>
  private readonly discovered = new Map<string, { maxBlob: number; features?: string[] }>()
  // LRU favors recent heads of each slot; retained copies survive peer departures.
  private readonly headProviders = new Map<string, { slot: string; providers: Set<string>; complete: boolean; broadcast: boolean }>()
  private historyEvicted = false
  private readonly deleting = new Set<string>()
  private readonly pending = new Map<string, Pending>()
  private readonly subscriptions: Unsubscribe[] = []
  private joining: Promise<void> | null = null
  private joined = false
  private closed = false
  private readonly providerListeners = new Set<() => void>()
  private readonly closing = new Set<() => void>()

  constructor(transport: EscrowTransport, room: string, options: EscrowClientOptions = {}) {
    if (!/^[A-Za-z0-9_./:-]{1,96}$/.test(room)) throw new Error('Invalid escrow room')
    this.transport = transport; this.room = room
    this.options = { maxBlob: DEFAULT_MAX_BLOB, maxPlaintext: DEFAULT_MAX_PLAINTEXT, getTimeoutMs: 4000, putTimeoutMs: 45000, ...options }
    if (!safeInt(this.options.maxBlob, 28) || !safeInt(this.options.maxPlaintext, 0)) throw new Error('Invalid escrow limits')
    this.timeout(this.options.getTimeoutMs); this.timeout(this.options.putTimeoutMs)
  }
  get providers(): ReadonlyMap<string, { maxBlob: number; features?: string[] }> {
    return new Map(Array.from(this.discovered, ([id, info]) => [id, { ...info, ...(info.features ? { features: [...info.features] } : {}) }]))
  }
  join(retry = false): Promise<void> {
    if (this.closed) return Promise.reject(new EscrowRequestError('closed', 'Escrow client closed'))
    if (retry && this.joined && this.joining && !this.discovered.size) {
      for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
      this.transport.leave(this.room)
      this.joining = null
      this.joined = false
    }
    if (!this.joining) {
      this.subscriptions.push(
        this.transport.onMessage(this.room, (id, bytes) => { void this.receive(id, bytes) }),
        this.transport.onPeer(this.room, (id, joined) => {
          if (this.closed) return
          if (joined) {
            try { this.send({ v: 1, type: 'escrow_hello' }, id) } catch { /* pending requests retain their timeout */ }
          } else {
            this.discovered.delete(id)
            for (const cb of this.providerListeners) cb()
            for (const request of this.pending.values()) {
              if (request.target === id) { request.target = undefined; this.dispatch(request) }
            }
          }
        }),
      )
      let timer: ReturnType<typeof setTimeout>
      let close: () => void
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EscrowRequestError('timeout', 'Escrow join timed out')), this.options.putTimeoutMs)
        close = () => reject(new EscrowRequestError('closed', 'Escrow client closed')); this.closing.add(close)
      })
      const joined = Promise.resolve().then(() => this.transport.join(this.room))
        .then(() => { if (this.closed) this.transport.leave(this.room) })
      this.joining = Promise.race([joined, timeout]).then(() => {
        if (this.closed) { this.transport.leave(this.room); return }
        this.joined = true
        this.send({ v: 1, type: 'escrow_hello' }, null)
      }).catch(error => {
        if (!this.closed) {
          for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
          this.discovered.clear()
          this.transport.leave(this.room)
          this.joining = null
          this.joined = false
          const failure = new EscrowRequestError('transport', String(error))
          for (const request of [...this.pending.values()]) request.finish(null, failure)
        }
        throw error
      }).finally(() => { clearTimeout(timer); this.closing.delete(close) })
    }
    return this.joining
  }
  onProvider(cb: () => void): Unsubscribe {
    this.providerListeners.add(cb)
    return () => { this.providerListeners.delete(cb) }
  }
  waitForProvider(timeoutMs = 20000): Promise<boolean> {
    this.timeout(timeoutMs)
    if (this.closed) return Promise.reject(new EscrowRequestError('closed', 'Escrow client closed'))
    if (this.discovered.size) return Promise.resolve(true)
    return new Promise((resolve, reject) => {
      const finish = (found: boolean, error?: unknown) => {
        clearTimeout(timer); off(); this.closing.delete(close)
        if (error) reject(error); else resolve(found)
      }
      const off = this.onProvider(() => { if (this.discovered.size) finish(true) })
      const close = () => finish(false, new EscrowRequestError('closed', 'Escrow client closed'))
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.closing.add(close)
      void this.join().catch(error => finish(false, error))
    })
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const close of [...this.closing]) close()
    this.providerListeners.clear()
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    for (const request of [...this.pending.values()]) request.finish(null, new EscrowRequestError('closed', 'Escrow client closed'))
    this.discovered.clear()
    this.headProviders.clear()
    this.transport.leave(this.room)
  }
  getHead(slot: string, timeoutMs = this.options.getTimeoutMs): Promise<EscrowHead | null> {
    if (!SLOT_RE.test(slot)) return Promise.reject(new Error('Invalid escrow slot'))
    return this.request({ v: 1, type: 'escrow_get', id: crypto.randomUUID(), slot }, timeoutMs) as Promise<EscrowHead | null>
  }
  async put(head: EscrowHead, timeoutMs = this.options.putTimeoutMs, signal?: AbortSignal): Promise<PutResult> {
    const parsed = parseHead(head, this.options)
    if (!parsed || !await verifyHead(parsed, { ...this.options, slot: parsed.slot, writer: parsed.writer }))
      return { type: 'error', code: 'bad_sig', message: 'Invalid escrow head' }
    const hash = await headHash(parsed, this.options)
    return this.request({ v: 1, type: 'escrow_put', id: crypto.randomUUID(), head: parsed }, timeoutMs, hash, undefined, undefined, signal) as Promise<PutResult>
  }
  async deleteSlot(app: string, input: string, current: EscrowHead): Promise<DeleteResult> {
    if (this.closed) return { type: 'error', code: 'closed', message: 'Escrow client closed' }
    return this.deleteWithKeys(await deriveEscrowKeys(app, input), current)
  }
  async deleteWithKeys(keys: EscrowKeys, current: EscrowHead): Promise<DeleteResult> {
    if (this.closed) return { type: 'error', code: 'closed', message: 'Escrow client closed' }
    if (!await verifyHead(current, { ...this.options, slot: keys.slot, writer: keys.writer }))
      return { type: 'error', code: 'bad_sig', message: 'Invalid escrow head' }
    const fields = await signDelete(current, keys, this.options)
    if (this.closed) return { type: 'error', code: 'closed', message: 'Escrow client closed' }
    try { await this.join() }
    catch (error) { return { type: 'error', code: 'transport', message: String(error) } }
    if (this.closed) return { type: 'error', code: 'closed', message: 'Escrow client closed' }
    const provenance = this.headProviders.get(fields.head)
    if (provenance) { this.headProviders.delete(fields.head); this.headProviders.set(fields.head, provenance) }
    if (this.deleting.has(fields.head) || [...this.pending.values()].some(request => request.message.type === 'escrow_put' && request.expectedHash === fields.head))
      return { type: 'error', code: 'busy', message: 'Escrow head mutation already in progress' }
    this.deleting.add(fields.head)
    try {
      const broadcast = !provenance || provenance.broadcast || !provenance.complete
      const targets = new Set(provenance?.providers)
      if (broadcast) for (const [id, provider] of this.discovered) {
        if (provider.features?.includes('delete')) targets.add(id)
      }
      if (!targets.size) return this.discovered.size
        ? { type: 'unsupported', message: 'No known provider supports slot deletion' }
        : { type: 'error', code: 'transport', message: 'No known providers; deletion cannot be confirmed' }
      const providers = [...targets]
      const results = await Promise.all(providers.map(provider => this.request(
        { v: 1, type: 'escrow_delete', id: crypto.randomUUID(), ...fields },
        this.options.putTimeoutMs, undefined, keys.writer, provider) as Promise<DeleteResult>))
      const failure = results.find(result => result.type !== 'deleted')
      if (failure) return failure
      if (this.historyEvicted && (!provenance || provenance.broadcast))
        return { type: 'error', code: 'transport', message: 'Escrow head provenance was evicted; deletion cannot be confirmed' }
      const latest = this.headProviders.get(fields.head)
      if ((provenance && latest !== provenance) || (latest && (!latest.complete || [...latest.providers].some(id => !targets.has(id))))
        || (broadcast && [...this.discovered].some(([id, provider]) => provider.features?.includes('delete') && !targets.has(id))))
        return { type: 'error', code: 'transport', message: 'Escrow head provider tracking changed or incomplete; retry deletion' }
      return { type: 'deleted' }
    } finally { this.deleting.delete(fields.head) }
  }
  fetchLatest(app: string, roomId: string, timeoutMs = 60000): Promise<{ head: EscrowHead; plaintext: Uint8Array } | null> {
    return this.fetchWithKeySource(() => deriveEscrowKeys(app, roomId), timeoutMs)
  }
  fetchLatestWithKeys(keys: EscrowKeys | Promise<EscrowKeys>, timeoutMs = 60000): Promise<{ head: EscrowHead; plaintext: Uint8Array } | null> {
    return this.fetchWithKeySource(() => Promise.resolve(keys), timeoutMs, true)
  }
  private fetchWithKeySource(source: () => Promise<EscrowKeys>, timeoutMs: number, managed = false): Promise<{ head: EscrowHead; plaintext: Uint8Array } | null> {
    this.timeout(timeoutMs)
    return new Promise((resolve, reject) => {
      let active = true
      const deadline = Date.now() + timeoutMs
      const close = () => finish(new EscrowRequestError('closed', 'Escrow client closed'))
      const finish = (error?: unknown, value?: { head: EscrowHead; plaintext: Uint8Array } | null) => {
        if (!active) return
        active = false
        clearTimeout(timer); this.closing.delete(close)
        if (error) reject(error); else resolve(value ?? null)
      }
      const timer = setTimeout(() => finish(new EscrowRequestError('timeout', 'Escrow restore timed out')), timeoutMs)
      this.closing.add(close)
      void this.downloadLatest(source, deadline, () => active, managed).then(value => finish(undefined, value), finish)
    })
  }
  private async downloadLatest(source: () => Promise<EscrowKeys>, deadline: number, active: () => boolean, managed: boolean): Promise<{ head: EscrowHead; plaintext: Uint8Array } | null> {
    const keys = await source()
    let reported = false
    const remaining = () => {
      if (this.closed || !active()) throw new EscrowRequestError('closed', 'Escrow restore stopped')
      const ms = deadline - Date.now()
      if (ms <= 0) throw new EscrowRequestError('timeout', 'Escrow restore timed out')
      return ms
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const head = await this.getHead(keys.slot, Math.min(this.options.getTimeoutMs, remaining()))
        if (!head) return null
        reported = true
        if (!await verifyHead(head, { ...this.options, slot: keys.slot, writer: keys.writer })) throw new Error('Escrow head verification failed')
        const ms = Math.min(30000 / 2 ** attempt, remaining())
        const blob = await new Promise<Uint8Array>((resolve, reject) => {
          const finish = (value?: Uint8Array, error?: unknown) => {
            clearTimeout(timer); this.closing.delete(close)
            if (error) reject(error); else resolve(value!)
          }
          const close = () => finish(undefined, new EscrowRequestError('closed', 'Escrow client closed'))
          const timer = setTimeout(() => finish(undefined, new EscrowRequestError('timeout', 'Escrow download timed out')), ms)
          if (managed) this.closing.add(close)
          void this.transport.storageGet(head.cid).then(value => finish(value), error => finish(undefined, error))
        })
        remaining()
        if (blob.byteLength !== head.size || await sha256(blob) !== head.sha256) throw new Error('Escrow blob hash or size mismatch')
        const decrypted = await decryptBlob(keys.encKey, keys.slot, head.seq, blob)
        const plaintext = head.comp === 'gzip' ? await gunzip(decrypted, this.options.maxPlaintext) : decrypted
        if (plaintext.byteLength > this.options.maxPlaintext) throw new Error('Escrow plaintext exceeds limit')
        remaining()
        return { head, plaintext }
      } catch (error) {
        if (!reported || attempt === 2 || this.closed || !active()) throw error
        await new Promise<void>((resolve, reject) => {
          const close = () => { clearTimeout(timer); this.closing.delete(close); reject(new EscrowRequestError('closed', 'Escrow client closed')) }
          const timer = setTimeout(() => { this.closing.delete(close); resolve() }, Math.min(250 * 2 ** attempt, remaining()))
          if (managed) this.closing.add(close)
        })
      }
    }
    throw new Error('Escrow restore retries exhausted')
  }
  async saveCheckpoint(app: string, roomId: string, plaintext: Uint8Array, options: CheckpointOptions): Promise<PutResult> {
    return this.saveWithKeySource(() => deriveEscrowKeys(app, roomId), plaintext, options)
  }
  async saveWithKeys(input: EscrowKeys | Promise<EscrowKeys>, plaintext: Uint8Array, options: CheckpointOptions): Promise<PutResult> {
    return this.saveWithKeySource(() => Promise.resolve(input), plaintext, options)
  }
  private async saveWithKeySource(source: () => Promise<EscrowKeys>, plaintext: Uint8Array, options: CheckpointOptions): Promise<PutResult> {
    if (plaintext.byteLength > this.options.maxPlaintext) throw new Error('Escrow plaintext exceeds limit')
    if (this.closed || options.signal?.aborted) return { type: 'error', code: this.closed ? 'closed' : 'timeout', message: 'Escrow save cancelled' }
    const ms = options.timeoutMs ?? this.options.putTimeoutMs
    this.timeout(ms)
    const abort = new AbortController(), end = Date.now() + ms
    const cancel = () => abort.abort(new EscrowRequestError('timeout', 'Escrow save cancelled'))
    const close = () => abort.abort(new EscrowRequestError('closed', 'Escrow client closed'))
    const timer = setTimeout(() => abort.abort(new EscrowRequestError('timeout', 'Escrow save timed out')), ms)
    this.closing.add(close); options.signal?.addEventListener('abort', cancel, { once: true })
    if (this.closed) close()
    else if (options.signal?.aborted) cancel()
    const check = () => {
      if (!abort.signal.aborted && Date.now() >= end) cancel()
      if (abort.signal.aborted) throw abort.signal.reason
    }
    const cancelled = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(abort.signal.reason)
      else abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
    })
    const wait = async <T>(pending: Promise<T>): Promise<T> => { const value = await Promise.race([pending, cancelled]); check(); return value }
    try {
      check()
      const keys = await wait(source())
      const comp = options.comp ?? (supportsGzip() ? 'gzip' : 'none')
      if (comp !== 'gzip' && comp !== 'none') throw new Error('Invalid escrow compression')
      const payload = comp === 'gzip' ? await wait(gzip(plaintext, this.options.maxBlob - 28)) : plaintext
      const blob = await wait(encryptBlob(keys.encKey, keys.slot, options.seq, payload))
      if (blob.byteLength > this.options.maxBlob) return { type: 'error', code: 'too_large', message: 'Escrow blob exceeds limit' }
      // Validate metadata before any upload.
      const fields = { seq: options.seq, parent: options.parent, schema: options.schema, comp, size: blob.byteLength, sha256: await wait(sha256(blob)) }
      await wait(buildHead(keys, { ...fields, cid: 'pending' }, this.options))
      await wait(this.join())
      const cid = await wait(this.transport.storageAdd('tc-escrow.bin', blob))
      const head = await wait(buildHead(keys, { ...fields, cid }, this.options))
      return await wait(this.put(head, Math.max(1, end - Date.now()), abort.signal))
    } catch (error) {
      if (error instanceof EscrowRequestError) return { type: 'error', code: error.code, message: error.message }
      throw error
    } finally { clearTimeout(timer); this.closing.delete(close); options.signal?.removeEventListener('abort', cancel) }
  }
  private timeout(ms: number): void {
    if (!safeInt(ms, 1, 2147483647)) throw new Error('Invalid escrow timeout')
  }
  private request(message: EscrowGet | EscrowPut | EscrowDelete, ms: number, hash?: string, writer?: string, pinnedTarget?: string, signal?: AbortSignal): Promise<EscrowHead | null | PutResult | DeleteResult> {
    this.timeout(ms)
    return new Promise((resolve, reject) => {
      const cancel = () => request.finish(null, new EscrowRequestError('timeout', 'Escrow save cancelled'))
      const request: Pending = {
        message, expectedHash: hash, writer, pinnedTarget,
        timer: setTimeout(() => request.finish(null, new EscrowRequestError('timeout', 'Escrow request timed out')), ms),
        finish: (value, error) => {
          if (!this.pending.delete(message.id)) return
          clearTimeout(request.timer)
          signal?.removeEventListener('abort', cancel)
          if (error) {
            if (message.type !== 'escrow_get') resolve({ type: 'error', code: error.code, message: error.message })
            else reject(error)
          } else resolve(value)
        },
      }
      this.pending.set(message.id, request)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) { cancel(); return }
      if (this.closed) { request.finish(null, new EscrowRequestError('closed', 'Escrow client closed')); return }
      void this.join().then(() => {
        if (this.pending.has(message.id)) this.dispatch(request)
      }).catch(error => request.finish(null, new EscrowRequestError('transport', String(error))))
    })
  }
  private send(message: EscrowMessage, id: string | null): void {
    this.transport.send(this.room, id, encodeEscrowMessage(message, this.options))
  }
  private dispatch(request: Pending): void {
    if (request.target || this.closed) return
    const entries = [...this.discovered].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const target = request.pinnedTarget
      ? entries.find(([id]) => id === request.pinnedTarget)
      : entries.find(([, provider]) => request.message.type !== 'escrow_put' || provider.maxBlob >= request.message.head.size)
    if (!target) {
      if (entries.length && request.message.type === 'escrow_put') request.finish(null, new EscrowRequestError('too_large', 'Provider blob limit exceeded'))
      return
    }
    if (request.message.type === 'escrow_delete' && !target[1].features?.includes('delete')) {
      request.finish({ type: 'unsupported', message: 'Provider does not support slot deletion' })
      return
    }
    if (request.message.type === 'escrow_put') {
      if (this.deleting.has(request.expectedHash!)) {
        request.finish(null, new EscrowRequestError('busy', 'Escrow head deletion in progress'))
        return
      }
      // Record before send: a throw, timeout or lost ACK does not prove non-storage.
      this.rememberProvider(request.expectedHash!, request.message.head.slot, target[0])
    }
    request.target = target[0]
    try { this.send(request.message, target[0]) }
    catch (error) { request.finish(null, new EscrowRequestError('transport', String(error))) }
  }
  private rememberProvider(hash: string, slot: string, provider: string): void {
    let provenance = this.headProviders.get(hash)
    if (!provenance) {
      if (this.headProviders.size >= 1024) {
        // Rotate this slot's oldest generation first, preserving other slots' latest heads.
        const entries = [...this.headProviders]
        const sameSlot = entries.filter(([, entry]) => entry.slot === slot)
        this.headProviders.delete((sameSlot.length ? sameSlot[0] : entries[0])[0])
        this.historyEvicted = true
      }
      // Without unbounded tombstones, a rediscovered hash could have evicted copies.
      provenance = { slot, providers: new Set(), complete: true, broadcast: this.historyEvicted }
    }
    this.headProviders.delete(hash)
    this.headProviders.set(hash, provenance)
    if (provenance.providers.has(provider)) return
    if (provenance.providers.size >= 64) { provenance.complete = false; return }
    provenance.providers.add(provider)
  }
  private async receive(fromId: string, bytes: Uint8Array): Promise<void> {
    if (this.closed) return
    const message = parseEscrowMessage(bytes, this.options)
    if (!message) return
    if (message.type === 'escrow_provider') {
      this.discovered.set(fromId, { maxBlob: message.maxBlob, ...(message.features ? { features: [...message.features] } : {}) })
      for (const cb of this.providerListeners) cb()
      for (const request of this.pending.values()) this.dispatch(request)
      return
    }
    if (!this.discovered.has(fromId) || !('id' in message)) return
    const request = this.pending.get(message.id)
    if (!request || request.target !== fromId) return
    const slot = request.message.type === 'escrow_put' ? request.message.head.slot : request.message.slot
    if (message.type === 'escrow_head' && request.message.type === 'escrow_get' && message.slot === slot) {
      const hash = message.head && await verifyHead(message.head, { ...this.options, slot, writer: message.head.writer })
        ? await headHash(message.head, this.options) : null
      if (this.pending.get(message.id) !== request || request.target !== fromId || !this.discovered.has(fromId)) return
      if (hash) this.rememberProvider(hash, slot, fromId)
      request.finish(message.head)
    } else if (message.type === 'escrow_ack' && request.message.type === 'escrow_put') {
      const ack: EscrowAck = message
      if (ack.slot === slot && ack.seq === request.message.head.seq && ack.hash === request.expectedHash) {
        request.finish({ type: 'ack', slot, seq: ack.seq, hash: ack.hash, head: request.message.head })
      }
    } else if (message.type === 'escrow_deleted' && request.message.type === 'escrow_delete' && message.slot === slot) {
      request.finish({ type: 'deleted' })
    } else if (message.type === 'escrow_error') {
      if (message.code === 'conflict') {
        if (request.message.type === 'escrow_get') return
        const writer = request.message.type === 'escrow_put' ? request.message.head.writer : request.writer!
        if (message.head && !await verifyHead(message.head, { ...this.options, slot, writer })) return
        if (this.pending.get(message.id) !== request || request.target !== fromId || !this.discovered.has(fromId)) return
        request.finish({ type: 'conflict', head: message.head })
      } else if (message.code === 'deleted' && request.message.type === 'escrow_put') {
        if (message.head && !await verifyHead(message.head, { ...this.options, slot, writer: request.message.head.writer })) return
        if (this.pending.get(message.id) !== request || request.target !== fromId || !this.discovered.has(fromId)) return
        request.finish({ type: 'error', code: message.code, message: message.message, ...(message.head ? { head: message.head } : {}) })
      } else request.finish(null, new EscrowRequestError(message.code, message.message))
    }
  }
}
