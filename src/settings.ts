import { parseVaultCode } from './code.js'
import { HASH_RE, isRecord, safeInt } from './core/head.js'
import { PART_ID_RE } from './core/crypto.js'

export type VaultMode = 'auto' | 'custom' | 'off'
export interface VaultSettings { v: 1; code: string; mode: VaultMode; room: string; rev: number }
export interface PartState { seq: number; hash: string; headHash?: string; unreferencedSince?: number }
export interface VaultAppState {
  v: 1; enabled: boolean; lastSeq: number; lastHash: string | null; dirty: boolean
  savedAt: number; restoredAt: number; parts: Record<string, PartState>; omitted: string[]
  scope?: string; editVersion?: number; editToken?: string
  pendingDeletes?: Record<string, PartState>
  partsObservedSeq?: number
}
export const SETTINGS_KEY = 'tc-vault:settings-v1'
export const appStateKey = (app: string): string => 'tc-vault:app:' + app + ':v1'
export const validVaultRoom = (room: string): boolean => /^[A-Za-z0-9_./:-]{1,96}$/.test(room)
export const defaultSettings = (): VaultSettings => ({ v: 1, code: '', mode: 'off', room: '', rev: 0 })
export const defaultAppState = (): VaultAppState => ({ v: 1, enabled: true, lastSeq: 0, lastHash: null,
  dirty: false, savedAt: 0, restoredAt: 0, parts: {}, omitted: [] })
export function browserStorage(): Storage | undefined { try { return globalThis.localStorage } catch { return undefined } }
function read(key: string, storage?: Storage): unknown { try { return JSON.parse(storage?.getItem(key) ?? 'null') } catch { return null } }
function write(key: string, value: unknown, storage?: Storage): void { try { storage?.setItem(key, JSON.stringify(value)) } catch { /* Storage is optional. */ } }
export function loadSettings(storage = browserStorage()): VaultSettings {
  const v = read(SETTINGS_KEY, storage)
  if (!isRecord(v) || v.v !== 1 || !safeInt(v.rev, 0) ||
    !(v.mode === 'auto' || v.mode === 'custom' || v.mode === 'off') || typeof v.room !== 'string' ||
    (v.mode === 'custom' ? !validVaultRoom(v.room) : v.room !== '') ||
    !(v.code === '' || typeof v.code === 'string' && parseVaultCode(v.code) === v.code)) return defaultSettings()
  return { v: 1, code: v.code as string, mode: v.mode, room: v.room, rev: v.rev }
}
export function saveSettings(value: VaultSettings, storage = browserStorage()): VaultSettings {
  const previous = loadSettings(storage)
  const rev = Math.max(value.rev, previous.rev)
  if (rev >= Number.MAX_SAFE_INTEGER) throw new Error('Vault settings revision exhausted')
  const next = { ...value, rev: rev + 1 }
  if (previous.code !== next.code || previous.mode !== 'off' && next.mode !== 'off' &&
    (previous.mode !== next.mode || previous.room !== next.room)) {
    // Reset unopened apps too; watermarks and attachment inventories belong to one destination.
    try {
      const keys = Array.from({ length: storage?.length ?? 0 }, (_, i) => storage!.key(i))
      for (const key of keys) if (key?.startsWith('tc-vault:app:') && key.endsWith(':v1')) {
        const app = key.slice(13, -3), old = loadAppState(app, storage)
        write(key, { ...defaultAppState(), enabled: old.enabled, dirty: old.dirty,
          editVersion: old.editVersion, editToken: old.editToken }, storage)
      }
    } catch { /* Controllers also reset their in-memory state. */ }
  }
  write(SETTINGS_KEY, next, storage)
  for (const cb of listeners) cb(storage, SETTINGS_KEY)
  return next
}
export function loadAppState(app: string, storage = browserStorage()): VaultAppState {
  const v = read(appStateKey(app), storage)
  const validParts = (parts: unknown) => isRecord(parts) && Object.entries(parts).every(([id, p]) =>
    PART_ID_RE.test(id) && isRecord(p) && safeInt(p.seq, 1) && typeof p.hash === 'string' && HASH_RE.test(p.hash) &&
    (p.headHash === undefined || typeof p.headHash === 'string' && HASH_RE.test(p.headHash)) &&
    (p.unreferencedSince === undefined || safeInt(p.unreferencedSince, 0)))
  if (!isRecord(v) || v.v !== 1 || typeof v.enabled !== 'boolean' || typeof v.dirty !== 'boolean' ||
    !safeInt(v.lastSeq, 0) || !(v.lastHash === null || typeof v.lastHash === 'string' && HASH_RE.test(v.lastHash)) ||
    (v.lastSeq === 0) !== (v.lastHash === null) || !safeInt(v.savedAt, 0) || !safeInt(v.restoredAt, 0) ||
    !validParts(v.parts) || (v.pendingDeletes !== undefined && !validParts(v.pendingDeletes)) ||
    (v.partsObservedSeq !== undefined && !safeInt(v.partsObservedSeq, 0)) ||
    (v.scope !== undefined && typeof v.scope !== 'string') ||
    (v.editVersion !== undefined && !safeInt(v.editVersion, 0)) ||
    (v.editToken !== undefined && typeof v.editToken !== 'string') ||
    !Array.isArray(v.omitted) || !v.omitted.every(id => typeof id === 'string' && PART_ID_RE.test(id))) return defaultAppState()
  return v as unknown as VaultAppState
}
export function saveAppState(app: string, value: VaultAppState, storage = browserStorage()): void {
  write(appStateKey(app), value, storage)
  for (const cb of listeners) cb(storage, appStateKey(app))
}
type Listener = (storage: Storage | undefined, key: string | null) => void
const listeners = new Set<Listener>()
export function subscribeSettings(cb: () => void, storage = browserStorage(), target: EventTarget | undefined = globalThis.window,
  app?: string): () => void {
  const relevant = (key: string | null) => key === null || key === SETTINGS_KEY || app !== undefined && key === appStateKey(app)
  const local: Listener = (area, key) => { if (area === storage && relevant(key)) cb() }
  const external = (event: Event) => {
    const e = event as StorageEvent
    if ((!e.storageArea || e.storageArea === storage) && relevant(e.key)) cb()
  }
  listeners.add(local); target?.addEventListener('storage', external)
  return () => { listeners.delete(local); target?.removeEventListener('storage', external) }
}
