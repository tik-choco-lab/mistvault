// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { VaultPanel } from './VaultPanel.js'
import type { VaultPanelProps } from './VaultPanel.js'
import { messages, resolveLocale } from '../i18n.js'
import type { VaultController, VaultView } from '../controller.js'

const roots: HTMLElement[] = []
const code = 'tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa'
const otherCode = 'tcv1-bbbbbbbbbbbbbbbbbbbbbbbbba'
afterEach(() => {
  for (const root of roots.splice(0)) { act(() => render(null, root)); root.remove() }
  history.replaceState(null, '', '/'); vi.useRealTimers(); vi.restoreAllMocks()
})
function setup(options: { view?: Partial<VaultView>; props?: Partial<Omit<VaultPanelProps, 'controller'>> } = {}) {
  let view: VaultView = { mode: 'auto', appEnabled: true, room: 'tce-123', autoRoom: 'tce-123', hasCode: true,
    status: 'saved', savedAt: Date.now() - 120000, restoredAt: 0, lastSeq: 1, hasParts: true,
    parts: { stored: 1, pending: 0, omitted: 2 }, ...options.view }
  const subscribers = new Set<(view: VaultView) => void>()
  const controller: VaultController = {
    getView: () => view, subscribe: cb => { subscribers.add(cb); return () => { subscribers.delete(cb) } },
    enable: vi.fn(), disable: vi.fn(), setAppEnabled: vi.fn(), configure: vi.fn(() => true), importCode: vi.fn(() => true),
    revealCode: vi.fn(() => code), saveNow: vi.fn(async () => {}), restoreNow: vi.fn(async () => {}), dispose: vi.fn(),
  }
  let props: Omit<VaultPanelProps, 'controller'> = { appName: 'Notebook', locale: 'en', ...options.props }
  const root = document.createElement('div'); document.body.append(root); roots.push(root)
  const rerender = (next: Partial<Omit<VaultPanelProps, 'controller'>> = {}) => {
    props = { ...props, ...next }; act(() => render(<VaultPanel controller={controller} {...props} />, root))
  }
  rerender()
  const button = (text: string, scope: ParentNode = root) => {
    const found = [...scope.querySelectorAll('button')].find(b => b.textContent === text)
    if (!found) throw new Error(`Button not found: ${text}`)
    return found
  }
  const details = (text: string) => {
    const found = [...root.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === text)
    if (!found) throw new Error(`Disclosure not found: ${text}`)
    return found
  }
  return { root, controller, subscribers, button, details, rerender,
    update(next: Partial<VaultView>) { act(() => { view = { ...view, ...next }; for (const cb of subscribers) cb(view) }) } }
}
function fill(input: HTMLInputElement, value: string) {
  act(() => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function offView(): Partial<VaultView> {
  return { mode: 'off', status: 'off', room: '', hasCode: false, savedAt: 0 }
}

it('shows only the welcome and two usable actions while off', () => {
  const { root, controller, button } = setup({ view: offView() })
  expect(root.querySelector('h2')?.textContent).toBe('Distributed vault')
  expect(root.querySelectorAll('p')).toHaveLength(1)
  expect([...root.querySelectorAll('button')].map(b => b.textContent)).toEqual([
    'Turn on the distributed vault', 'Use a code from another device',
  ])
  expect(root.querySelector('input, select, details, [role=status]')).toBeNull()
  expect(root.querySelector('button:disabled')).toBeNull()
  act(() => button('Turn on the distributed vault').click())
  expect(controller.enable).toHaveBeenCalledOnce()
})

it('validates a typed code, requires confirmation and enables an off vault after import', async () => {
  const { root, controller, button } = setup({ view: offView() })
  act(() => button('Use a code from another device').click())
  const input = root.querySelector<HTMLInputElement>('input[type=password]')!
  expect(document.activeElement).toBe(input)
  expect(input.closest('label')?.textContent).toBe('Code from another device')
  fill(input, 'bad')
  act(() => button('Import code').click())
  expect(root.querySelector('[role=alert]')?.textContent).toBe('Invalid vault code.')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(controller.importCode).not.toHaveBeenCalled()
  fill(input, code.toUpperCase())
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  const prompt = root.querySelector<HTMLElement>('[role=group]')!
  expect(root.querySelector('.mv-panel')?.firstElementChild).toBe(prompt)
  expect(prompt.getAttribute('aria-label')).toContain('Your local data stays on this device')
  expect(document.activeElement).toBe(prompt)
  expect(controller.importCode).not.toHaveBeenCalled()
  act(() => button('Cancel', prompt).click())
  expect(controller.importCode).not.toHaveBeenCalled()
  expect(root.querySelector('[role=group]')).toBeNull()
  act(() => button('Use a code from another device').click())
  fill(root.querySelector<HTMLInputElement>('input[type=password]')!, code)
  act(() => button('Import code').click())
  act(() => button('Confirm import').click())
  expect(controller.importCode).toHaveBeenCalledOnce()
  expect(controller.importCode).toHaveBeenCalledWith(code)
  expect(controller.enable).toHaveBeenCalledOnce()
  expect(vi.mocked(controller.importCode).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(controller.enable).mock.invocationCallOrder[0])
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  expect(document.activeElement).toBe(button('Use a code from another device'))
})

it('shows live status, saved time, app switch and parts only for adapters with parts', () => {
  const { root, button, controller, update, subscribers } = setup()
  expect(root.querySelector('[role=status]')?.textContent).toContain('Saved 2 min ago')
  expect(root.textContent).toContain('Attachments: 1 stored, 0 pending, 2 omitted')
  expect(root.querySelector('label.mv-switch')?.textContent).toContain('Back up Notebook data')
  act(() => button('Save now').click()); act(() => button('Restore now').click())
  expect(controller.saveNow).toHaveBeenCalledOnce(); expect(controller.restoreNow).toHaveBeenCalledOnce()
  const toggle = root.querySelector<HTMLInputElement>('input[role=switch]')!
  act(() => { toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(controller.setAppEnabled).toHaveBeenCalledWith(false)
  update({ status: 'saving' }); expect(button('Save now').disabled).toBe(true)
  update({ status: 'off', appEnabled: false, room: '', hasParts: false })
  expect(root.querySelector('[role=status]')?.textContent).toContain('Backup is off for this app')
  expect(button('Restore now').disabled).toBe(true)
  expect(root.textContent).not.toContain('Attachments:')
  expect(root.querySelector<HTMLInputElement>('.mv-room input')?.placeholder).toBe('Available when backup is on')
  act(() => render(null, root)); expect(subscribers.size).toBe(0)
})

it('formats recent, hourly and daily saved times', () => {
  const { root, update } = setup()
  const status = () => root.querySelector('[role=status]')!.textContent!
  update({ savedAt: Date.now() }); expect(status()).toContain('Saved just now')
  update({ savedAt: Date.now() - 2 * 60 * 60 * 1000 }); expect(status()).toContain('Saved 2 hr ago')
  update({ savedAt: Date.now() - 24 * 60 * 60 * 1000 }); expect(status()).toContain('Saved 1 day ago')
  update({ savedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }); expect(status()).toContain('Saved 3 days ago')
})

it('keeps the vault code masked until revealed and copies the room, code and link', async () => {
  const { root, button, controller, details } = setup()
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const vaultCode = details('Vault code')
  expect(vaultCode.open).toBe(false)
  expect(root.innerHTML).not.toContain(code)
  expect(controller.revealCode).not.toHaveBeenCalled()
  expect(vaultCode.querySelector('summary')?.textContent).toBe('Vault code')
  expect(vaultCode.querySelectorAll('label')).toHaveLength(0)
  act(() => { vaultCode.open = true })
  const field = vaultCode.querySelector<HTMLInputElement>('input[readonly]')!
  expect(field.type).toBe('password'); expect(field.getAttribute('aria-label')).toBe('Vault code')
  await act(async () => { button('Copy', root.querySelector('.mv-room')!).click() })
  expect(clipboard).toHaveBeenLastCalledWith('tce-123')
  await act(async () => { button('Copy', vaultCode).click() })
  expect(clipboard).toHaveBeenLastCalledWith(code)
  await act(async () => { button('Copy link for another device').click() })
  expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('#tc-vault=' + code))
  act(() => button('Reveal').click())
  expect(field.type).toBe('text'); expect(field.value).toBe(code)
  act(() => { vaultCode.open = false; vaultCode.dispatchEvent(new Event('toggle')) })
  expect(field.type).toBe('password'); expect(root.innerHTML).not.toContain(code)
})

it('opens advanced settings, validates a custom room and applies each mode', () => {
  const { root, controller, button, details } = setup()
  const advanced = details('Advanced')
  expect(advanced.open).toBe(false)
  act(() => { advanced.open = true })
  const select = advanced.querySelector<HTMLSelectElement>('select')!
  expect([...select.options].map(o => o.value)).toEqual(['auto', 'custom', 'off'])
  act(() => { select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  const room = advanced.querySelector<HTMLInputElement>('input')!
  expect(room.closest('label')?.textContent).toBe('mistl room')
  fill(room, 'invalid room')
  expect(room.getAttribute('aria-invalid')).toBe('true'); expect(button('Apply').disabled).toBe(true)
  fill(room, 'my-room:123')
  expect(button('Apply').disabled).toBe(false)
  act(() => button('Apply').click()); expect(controller.configure).toHaveBeenCalledWith('custom', 'my-room:123')
  act(() => { select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  act(() => button('Apply').click()); expect(controller.configure).toHaveBeenLastCalledWith('off', 'my-room:123')
})

it('consumes a device link, preserves other URL state and asks before importing', () => {
  history.replaceState(null, '', '/app?x=1#other=1&tc-vault=' + code)
  const handled = vi.fn()
  const { root, controller, button } = setup({ props: { onPendingHandled: handled } })
  expect(location.search).toBe('?x=1'); expect(location.hash).toBe('#other=1')
  expect(root.querySelector('.mv-panel')?.firstElementChild?.getAttribute('role')).toBe('group')
  expect(controller.importCode).not.toHaveBeenCalled()
  act(() => button('Confirm import').click())
  expect(controller.importCode).toHaveBeenCalledWith(code)
  expect(controller.enable).not.toHaveBeenCalled()
  expect(handled).not.toHaveBeenCalled()
})

it('handles supplied pending codes after mount and reports cancellation or import once', () => {
  const handled = vi.fn()
  const { root, controller, button, rerender } = setup({ view: offView(), props: { onPendingHandled: handled } })
  expect(root.querySelector('[role=group]')).toBeNull()
  rerender({ pendingCode: code })
  expect(controller.importCode).not.toHaveBeenCalled()
  act(() => button('Cancel').click())
  expect(handled).toHaveBeenCalledOnce(); expect(handled).toHaveBeenLastCalledWith('cancelled')
  rerender({ appName: 'Changed' })
  expect(root.querySelector('[role=group]')).toBeNull()
  rerender({ pendingCode: null }); rerender({ pendingCode: code })
  expect(root.querySelector('[role=group]')).not.toBeNull()
  act(() => button('Confirm import').click())
  expect(controller.importCode).toHaveBeenCalledWith(code); expect(controller.enable).toHaveBeenCalledOnce()
  expect(handled).toHaveBeenCalledTimes(2); expect(handled).toHaveBeenLastCalledWith('imported')
  rerender(); expect(root.querySelector('[role=group]')).toBeNull()
})

it('preserves an automatic link if a separately supplied pending code is also present', () => {
  history.replaceState(null, '', '/#tc-vault=' + code)
  const handled = vi.fn()
  const { root, button, controller } = setup({ props: { pendingCode: otherCode, onPendingHandled: handled } })
  expect(location.hash).toBe('')
  act(() => button('Confirm import').click())
  expect(controller.importCode).toHaveBeenNthCalledWith(1, otherCode)
  expect(handled).toHaveBeenCalledWith('imported')
  expect(root.querySelector('[role=group]')).not.toBeNull()
  act(() => button('Confirm import').click())
  expect(controller.importCode).toHaveBeenNthCalledWith(2, code)
  expect(handled).toHaveBeenCalledTimes(1)
})

it('allows invalid or failed supplied imports to be dismissed without claiming success', () => {
  const handled = vi.fn()
  const { root, button, controller, rerender } = setup({ props: { pendingCode: 'bad', onPendingHandled: handled } })
  expect(root.querySelector('[role=group]')?.textContent).toContain('Invalid vault code.')
  expect([...root.querySelectorAll('button')].some(b => b.textContent === 'Confirm import')).toBe(false)
  act(() => button('Cancel').click())
  expect(handled).toHaveBeenLastCalledWith('cancelled')
  rerender({ pendingCode: code })
  vi.mocked(controller.importCode).mockReturnValue(false)
  act(() => button('Confirm import').click())
  expect(root.querySelector('[role=alert]')?.textContent).toBe('Could not import this vault code.')
  expect(handled).toHaveBeenCalledTimes(1)
  expect(root.querySelector('[role=group]')).not.toBeNull()
  act(() => button('Cancel').click())
  expect(handled).toHaveBeenLastCalledWith('cancelled')
})

it('supports importing another code and dismissing the editor with Escape', () => {
  const { root, button, details } = setup()
  act(() => { details('Vault code').open = true; button('Import another code').click() })
  const input = root.querySelector<HTMLInputElement>('.mv-import input')!
  expect(document.activeElement).toBe(input)
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(root.querySelector('.mv-import input')).toBeNull()
  expect(document.activeElement).toBe(button('Import another code'))
})

it('gives separate panels unique labels and control IDs', () => {
  const first = setup(), second = setup()
  const ids = [...document.querySelectorAll('.mv-panel [id]')].map(el => el.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const { root } of [first, second]) {
    const label = root.querySelector<HTMLLabelElement>('.mv-room label')!
    expect(label.control).toBe(root.querySelector('.mv-room input'))
    expect(label.control?.hasAttribute('readonly')).toBe(true)
  }
})

it('provides complete localized setup and enabled views in all four locales', () => {
  const expected = Object.keys(messages.en).sort()
  for (const dict of Object.values(messages)) {
    expect(Object.keys(dict).sort()).toEqual(expected)
    for (const value of Object.values(dict)) expect(value.trim().length).toBeGreaterThan(0)
  }
  expect(['en-US', 'ja-JP', 'zh-Hans', 'zh-Hant', 'zh-HK', 'fr'].map(resolveLocale)).toEqual(['en', 'ja', 'zh-CN', 'zh-TW', 'zh-TW', 'en'])
  expect(messages.ja.title).toBe('分散保管庫')
  for (const locale of ['en', 'ja', 'zh-CN', 'zh-TW'] as const) {
    const { root, update, rerender } = setup({ view: offView(), props: { locale } })
    expect(root.querySelector('h2')?.textContent).toBe(messages[locale].title)
    expect(root.textContent).toContain(messages[locale].turnOn)
    update({ mode: 'auto', status: 'saved', room: 'tce-123', hasCode: true })
    rerender({ locale })
    expect(root.textContent).toContain(messages[locale].advanced)
    expect(root.textContent).toContain(messages[locale].code)
    expect(root.textContent).not.toContain('undefined')
  }
})
