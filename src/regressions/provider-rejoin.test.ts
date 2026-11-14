import { expect, it, vi } from 'vitest'
import { harness, record, remote, settings } from '../testing/regression-helpers.js'

it('retries joining after a transient initial transport failure', async () => {
  const h = harness(); settings(h.storage)
  h.provider.join.mockRejectedValueOnce(new Error('Temporarily offline'))
  vi.useFakeTimers()
  const v = h.start()
  await vi.waitFor(() => expect(v.getView().status).toBe('error'))
  h.edit(record('unsaved while offline'))
  await vi.advanceTimersByTimeAsync(60000)
  await vi.waitFor(() => expect(v.getView().lastSeq).toBeGreaterThan(0))
  await v.restoreNow(); await v.saveNow()
  expect(h.provider.join).toHaveBeenCalledTimes(2)
  expect((await remote(h.provider)).records.item.value).toBe('unsaved while offline')
})

it('backs off repeated join failures from five to ten seconds', async () => {
  const h = harness(); settings(h.storage)
  const attempts: number[] = []
  h.provider.join.mockImplementationOnce(async () => { attempts.push(Date.now()); throw new Error('Offline') })
    .mockImplementationOnce(async () => { attempts.push(Date.now()); throw new Error('Still offline') })
  vi.useFakeTimers()
  const v = h.start()
  await vi.waitFor(() => expect(v.getView().status).toBe('error'))
  await vi.advanceTimersByTimeAsync(4999 - (Date.now() - attempts[0]))
  expect(h.provider.join).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(h.provider.join).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(9999)
  expect(h.provider.join).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  await v.saveNow()
  expect(h.provider.join).toHaveBeenCalledTimes(3)
  expect(v.getView().lastSeq).toBe(1)
})

it('recovers from a synchronous transport join exception', async () => {
  const h = harness(); settings(h.storage)
  h.provider.join.mockImplementationOnce(() => { throw new Error('Connection unavailable') })
  vi.useFakeTimers(); const v = h.start()
  await vi.waitFor(() => expect(v.getView().status).toBe('error'))
  await vi.advanceTimersByTimeAsync(5000); await v.saveNow()
  expect(h.provider.join).toHaveBeenCalledTimes(2)
  expect(v.getView().lastSeq).toBe(1)
  v.dispose(); expect(vi.getTimerCount()).toBe(0)
})

it('rejoins after the last provider leaves and saves offline edits', async () => {
  const h = harness(); settings(h.storage); const v = h.start(); await v.saveNow()
  vi.useFakeTimers(); h.provider.online = false
  for (const cb of h.provider.peers.get('vault') ?? []) cb('provider', false)
  expect(v.getView().status).toBe('noProvider')
  h.edit(record('offline edit', 3)); h.provider.online = true
  await vi.advanceTimersByTimeAsync(5000); await v.saveNow()
  expect(h.provider.join).toHaveBeenCalledTimes(2)
  expect((await remote(h.provider)).records.item.value).toBe('offline edit')
})

it('retries immediately on online and does not join while hidden', async () => {
  const window = new EventTarget(), document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} }
  vi.stubGlobal('window', window); vi.stubGlobal('document', document)
  const h = harness(); settings(h.storage); h.provider.join.mockRejectedValueOnce(new Error('Offline'))
  vi.useFakeTimers(); const v = h.start()
  await vi.waitFor(() => expect(v.getView().status).toBe('error'))
  await vi.advanceTimersByTimeAsync(5000)
  expect(h.provider.join).toHaveBeenCalledTimes(1)
  document.visibilityState = 'visible'; window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(0); await v.saveNow()
  expect(h.provider.join).toHaveBeenCalledTimes(2)
  expect(v.getView().lastSeq).toBe(1)
})
