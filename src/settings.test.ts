import { expect, it, vi } from 'vitest'
import { appStateKey, defaultAppState, defaultSettings, loadAppState, loadSettings, saveAppState, saveSettings, SETTINGS_KEY, subscribeSettings } from './settings.js'
import { memoryStorage } from './testing/memory.js'

it('defaults off and tolerates corrupt settings, states and unavailable storage', () => {
  const storage = memoryStorage()
  expect(loadSettings(storage)).toEqual(defaultSettings()); expect(loadAppState('a', storage)).toEqual(defaultAppState())
  for (const value of ['{', 'null', '{}', '{"v":1,"mode":"bad"}']) {
    storage.setItem(SETTINGS_KEY, value); storage.setItem(appStateKey('a'), value)
    expect(loadSettings(storage)).toEqual(defaultSettings()); expect(loadAppState('a', storage)).toEqual(defaultAppState())
  }
  const blocked = { getItem() { throw new Error('Blocked') }, setItem() { throw new Error('Full') } } as unknown as Storage
  expect(() => saveSettings(defaultSettings(), blocked)).not.toThrow()
  expect(() => saveAppState('a', defaultAppState(), blocked)).not.toThrow()
  expect(loadSettings(blocked)).toEqual(defaultSettings())
})
it('increments revisions, notifies same-page subscriptions, and re-reads storage events', () => {
  const storage = memoryStorage(), target = new EventTarget(), changed = vi.fn(() => loadSettings(storage))
  const off = subscribeSettings(changed, storage, target)
  const one = saveSettings(defaultSettings(), storage), two = saveSettings(defaultSettings(), storage)
  expect([one.rev, two.rev]).toEqual([1, 2]); expect(changed).toHaveBeenCalledTimes(2)
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...two, mode: 'auto', code: 'tcv1-' + 'a'.repeat(26) }))
  target.dispatchEvent(Object.assign(new Event('storage'), { key: SETTINGS_KEY, storageArea: storage }))
  expect(changed).toHaveLastReturnedWith(expect.objectContaining({ mode: 'auto' }))
  target.dispatchEvent(Object.assign(new Event('storage'), { key: 'other', storageArea: storage }))
  expect(changed).toHaveBeenCalledTimes(3); off()
  target.dispatchEvent(Object.assign(new Event('storage'), { key: null, storageArea: storage }))
  expect(changed).toHaveBeenCalledTimes(3)
})
it('resets every stored app watermark when the code switches, retaining app preference', () => {
  const storage = memoryStorage()
  saveAppState('a', { ...defaultAppState(), enabled: false, lastSeq: 4, lastHash: 'a'.repeat(64), parts: { f: { seq: 2, hash: 'b'.repeat(64) } } }, storage)
  saveSettings({ ...defaultSettings(), code: 'tcv1-' + 'a'.repeat(26), mode: 'auto' }, storage)
  expect(loadAppState('a', storage)).toEqual({ ...defaultAppState(), enabled: false })
})
it('rejects malformed metadata rather than partially trusting it', () => {
  const storage = memoryStorage()
  for (const patch of [{ lastSeq: -1 }, { lastSeq: 1 }, { parts: { 'bad/id': { seq: 1, hash: 'a'.repeat(64) } } },
    { parts: { f: { seq: 1, hash: 'a'.repeat(64), unreferencedSince: -1 } } }, { partsObservedSeq: -1 },
    { omitted: [1] }, { savedAt: NaN }]) {
    storage.setItem(appStateKey('a'), JSON.stringify({ ...defaultAppState(), ...patch }))
    expect(loadAppState('a', storage)).toEqual(defaultAppState())
  }
})
