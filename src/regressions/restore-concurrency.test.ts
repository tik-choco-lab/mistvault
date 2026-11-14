import { expect, it, vi } from 'vitest'
import { loadAppState } from '../settings.js'
import { app, harness, record, settings, seed, ready, remote } from '../testing/regression-helpers.js'

it('preserves an edit made after snapshot capture and before restore apply', async () => {
  const h = harness(); settings(h.storage); await seed(h.provider, record('remote', 2))
  const snapshot = h.adapter.snapshot
  let once = true
  h.adapter.snapshot = async () => {
    const captured = await snapshot()
    if (once) { once = false; h.edit(record('new local edit', 3)) }
    return captured
  }
  const v = h.start(); await v.restoreNow()
  expect(h.box.data.records.item.value).toBe('new local edit')
})

it('persists dirty for a user edit while an asynchronous apply is pending', async () => {
  const h = harness(); settings(h.storage); await seed(h.provider, record('remote', 2))
  const apply = h.adapter.apply
  let entered = false, release!: () => void
  h.adapter.apply = async next => {
    await apply(next); entered = true
    await new Promise<void>(resolve => { release = resolve })
  }
  const v = h.start()
  await vi.waitFor(() => expect(entered).toBe(true))
  h.edit(record('edit during apply', 3)); release(); await ready(v)
  expect(loadAppState(app, h.storage).dirty).toBe(true)
  await v.saveNow()
  expect((await remote(h.provider)).records.item.value).toBe('edit during apply')
})

it('marks dirty when apply preserves a newer local record without notifying', async () => {
  const h = harness(); settings(h.storage); await seed(h.provider, record('remote', 2))
  h.adapter.apply = () => { h.box.data = record('preserved by revision check', 3) }
  const v = h.start(); await ready(v)
  expect(loadAppState(app, h.storage).dirty).toBe(true)
  await v.saveNow()
  expect((await remote(h.provider)).records.item.value).toBe('preserved by revision check')
})

it('bounds resnapshot retries without applying an outdated merge', async () => {
  const h = harness(); settings(h.storage); await seed(h.provider, record('remote', 2))
  let revision = 2
  h.adapter.snapshot = () => {
    const captured = structuredClone(h.box.data)
    h.edit(record('editing', ++revision))
    return captured
  }
  const apply = vi.spyOn(h.adapter, 'apply'), v = h.start()
  await vi.waitFor(() => expect(v.getView().status).toBe('error'))
  expect(apply).not.toHaveBeenCalled()
  expect(revision).toBe(6)
  expect(loadAppState(app, h.storage).dirty).toBe(true)
})
