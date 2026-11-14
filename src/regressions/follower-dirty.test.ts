import { expect, it, vi } from 'vitest'
import { loadAppState } from '../settings.js'
import { app, empty, harness, MemoryProvider, memoryStorage, ready, record, remote, settings } from '../testing/regression-helpers.js'

it('the writer saves edits made in a follower tab sharing the same app store', async () => {
  let acquired = false
  vi.stubGlobal('navigator', { locks: { request: (_name: string, options: { signal: AbortSignal }, cb: () => Promise<void>) => {
    if (!acquired) { acquired = true; return cb() }
    return new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError'))))
  } } })
  const p = new MemoryProvider(), storage = memoryStorage(), box = { data: empty() }
  settings(storage)
  const a = harness(p, storage, box), b = harness(p, storage, box)
  const writer = a.start(); await writer.saveNow()
  const follower = b.start(); await ready(follower)
  vi.useFakeTimers()
  b.edit(record('follower edit', 3))
  expect(loadAppState(app, storage).dirty).toBe(true)
  await vi.advanceTimersByTimeAsync(60000)
  // Drain both poll jobs without causing a follower save itself.
  await writer.saveNow(); await follower.saveNow()
  expect((await remote(p)).records.item?.value).toBe('follower edit')
  await follower.restoreNow()
  expect(loadAppState(app, storage).dirty).toBe(false)
})

it('does not clear a follower edit made after the writer captured its saved snapshot', async () => {
  let acquired = false
  vi.stubGlobal('navigator', { locks: { request: (_name: string, options: { signal: AbortSignal }, cb: () => Promise<void>) => {
    if (!acquired) { acquired = true; return cb() }
    return new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError'))))
  } } })
  const p = new MemoryProvider(), storage = memoryStorage(), box = { data: empty() }
  settings(storage)
  const a = harness(p, storage, box), b = harness(p, storage, box)
  const writer = a.start(); await writer.saveNow()
  const follower = b.start(); await ready(follower)
  a.edit(record('snapshot being saved', 2))
  let once = true
  p.beforePut = async () => { if (once) { once = false; b.edit(record('later follower edit', 3)) } }
  await writer.saveNow()
  expect(loadAppState(app, storage).dirty).toBe(true)
  expect((await remote(p)).records.item.value).toBe('snapshot being saved')
  await writer.saveNow()
  expect((await remote(p)).records.item.value).toBe('later follower edit')
  await follower.restoreNow(); await writer.saveNow()
  expect(loadAppState(app, storage).dirty).toBe(false)
})
