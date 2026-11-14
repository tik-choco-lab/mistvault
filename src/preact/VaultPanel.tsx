import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { VaultController } from '../controller.js'
import type { VaultMode } from '../settings.js'
import { validVaultRoom } from '../settings.js'
import { consumeVaultLink, parseVaultCode, vaultLink } from '../code.js'
import { vaultMessage } from '../i18n.js'
import type { VaultMessages } from '../i18n.js'
import { useVault } from './useVault.js'

export interface VaultPanelProps {
  controller: VaultController
  locale?: string
  appName?: string
  /** A device-link code consumed by the application before the panel was mounted. */
  pendingCode?: string | null
  /** Called after a supplied pending code is imported or dismissed. Clear pendingCode in the caller. */
  onPendingHandled?: (result: 'imported' | 'cancelled') => void
}

export function VaultPanel({ controller, locale, appName, pendingCode, onPendingHandled }: VaultPanelProps) {
  const view = useVault(controller)
  const t = (key: keyof VaultMessages, values?: Record<string, string | number>) => vaultMessage(locale, key, values)
  const [mode, setMode] = useState(view.mode), [room, setRoom] = useState(view.room)
  const [visible, setVisible] = useState(false), [input, setInput] = useState('')
  const [importing, setImporting] = useState(false), [inputError, setInputError] = useState('')
  const [propPending, setPropPending] = useState<string | null>(pendingCode || null)
  const [localPending, setLocalPending] = useState<string | null>(() => {
    try { return typeof window === 'undefined' ? null : consumeVaultLink() } catch { return null }
  })
  const [confirmError, setConfirmError] = useState('')
  const [notice, setNotice] = useState(''), [time, setTime] = useState(Date.now())
  const confirmRef = useRef<HTMLDivElement>(null), importRef = useRef<HTMLInputElement>(null)
  const importButtonRef = useRef<HTMLButtonElement>(null), titleRef = useRef<HTMLHeadingElement>(null)
  const pending = propPending ?? localPending
  const parsedPending = pending === null ? null : parseVaultCode(pending)

  useLayoutEffect(() => { setPropPending(pendingCode || null) }, [pendingCode])
  useLayoutEffect(() => {
    setConfirmError('')
    if (pending !== null) confirmRef.current?.focus()
  }, [pending])
  useLayoutEffect(() => { if (importing) importRef.current?.focus() }, [importing])
  useLayoutEffect(() => { setMode(view.mode); setRoom(view.room); setVisible(false) }, [view.mode, view.room, controller])
  useLayoutEffect(() => { setImporting(false); setInput(''); setInputError(''); setNotice('') }, [view.mode, controller])
  useEffect(() => { const timer = setInterval(() => setTime(Date.now()), 60000); return () => clearInterval(timer) }, [])

  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(t('copied')) } catch { setNotice(t('copyError')) }
  }
  const closeImport = () => {
    setImporting(false); setInput(''); setInputError('')
    importButtonRef.current?.focus()
  }
  const prepareImport = () => {
    const code = parseVaultCode(input)
    if (!code) { setInputError(t('invalidCode')); return }
    setInputError(''); setNotice(''); setLocalPending(code)
  }
  const finishPending = (result: 'imported' | 'cancelled') => {
    if (propPending !== null) { setPropPending(null); onPendingHandled?.(result) }
    else setLocalPending(null)
    setInput(''); setInputError(''); setImporting(false); setVisible(false); setConfirmError('')
    requestAnimationFrame(() => {
      if (confirmRef.current) return
      const button = importButtonRef.current
      if (button?.isConnected && !button.closest('details:not([open])')) button.focus()
      else titleRef.current?.focus()
    })
  }
  const confirmImport = () => {
    if (!parsedPending || !controller.importCode(parsedPending)) { setConfirmError(t('importError')); return }
    if (view.mode === 'off') controller.enable()
    finishPending('imported')
  }
  const importForm = importing && <div class="mv-import">
    <label>{t('importLabel')}
      <input ref={importRef} type="password" value={input} autoComplete="off" aria-invalid={!!inputError}
        onInput={e => { setInput(e.currentTarget.value); setInputError('') }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); prepareImport() } else if (e.key === 'Escape') closeImport() }} />
    </label>
    {inputError && <p class="mv-error" role="alert">{inputError}</p>}
    <div class="mv-actions"><button type="button" class="mv-primary" onClick={prepareImport}>{t('import')}</button>
      <button type="button" onClick={closeImport}>{t('cancel')}</button></div>
  </div>
  const busy = view.status === 'saving' || view.status === 'restoring'
  const enabled = view.appEnabled && view.hasCode
  const minutes = Math.max(0, Math.floor((Math.max(time, Date.now()) - view.savedAt) / 60000))
  const savedTime = minutes < 1 ? t('savedNow') : minutes < 60 ? t('savedAgo', { minutes }) :
    minutes < 1440 ? t('savedHoursAgo', { hours: Math.floor(minutes / 60) }) :
      minutes < 2880 ? t('savedDayAgo') : t('savedDaysAgo', { days: Math.floor(minutes / 1440) })

  return <section class="mv-panel" aria-label={t('title')}>
    {pending !== null && <div ref={confirmRef} class="mv-confirm" role="group"
      aria-label={t('pendingTitle') + ' ' + t(parsedPending ? 'confirmation' : 'invalidCode')} tabIndex={-1}>
      <h3>{t('pendingTitle')}</h3>
      <p>{parsedPending ? t('confirmation') : t('invalidCode')}</p>
      {confirmError && <p class="mv-error" role="alert">{confirmError}</p>}
      <div class="mv-actions">{parsedPending && <button type="button" class="mv-primary" onClick={confirmImport}>{t('confirm')}</button>}
        <button type="button" onClick={() => finishPending('cancelled')}>{t('cancel')}</button></div>
    </div>}
    <h2 ref={titleRef} tabIndex={-1}>{t('title')}</h2>
    {view.mode === 'off' ? <div class="mv-welcome">
      <p class="mv-muted">{t('explanation')}</p>
      <div class="mv-stack"><button type="button" class="mv-primary" onClick={() => controller.enable()}>{t('turnOn')}</button>
        <button ref={importButtonRef} type="button" aria-expanded={importing}
          onClick={() => importing ? closeImport() : setImporting(true)}>{t('useCode')}</button></div>
      {importForm}
    </div> : <>
      <div class="mv-status-card">
        <div class="mv-status-text" role="status" aria-live="polite" data-state={!view.appEnabled ? 'off' : view.status}>
          <strong>{!view.appEnabled && view.status === 'off' ? t('status_appOff') : t(`status_${view.status}`)}</strong>
          {view.savedAt > 0 && <span class="mv-muted">{' '}{savedTime}</span>}
          {view.error && <span class="mv-error">{' '}{view.error}</span>}
        </div>
        <div class="mv-actions"><button type="button" disabled={!enabled || busy} onClick={() => { void controller.saveNow() }}>{t('save')}</button>
          <button type="button" disabled={!enabled || busy} onClick={() => { void controller.restoreNow() }}>{t('restore')}</button></div>
      </div>
      <label class="mv-switch"><span>{t('app', { app: appName || t('appFallback') })}</span>
        <input type="checkbox" role="switch" checked={view.appEnabled} onChange={e => controller.setAppEnabled(e.currentTarget.checked)} /></label>
      <div class="mv-room"><div class="mv-room-row"><label>{t('room')}
          <input readOnly value={view.room} placeholder={t(view.appEnabled ? 'roomPending' : 'roomUnavailable')}
            onFocus={e => e.currentTarget.select()} /></label>
          <button type="button" disabled={!view.room} onClick={() => { void copy(view.room) }}>{t('copy')}</button></div>
        <p class="mv-muted mv-hint">{t('hint')}</p>
      </div>
      <details class="mv-disclosure" onToggle={e => { if (!e.currentTarget.open) setVisible(false) }}>
        <summary>{t('code')}</summary><div class="mv-disclosure-body">
          <p class="mv-muted">{t('codeHint')}</p>
          <input class="mv-code" aria-label={t('code')} readOnly type={visible ? 'text' : 'password'}
            value={visible ? controller.revealCode() ?? '' : view.hasCode ? '0000000000000000' : ''}
            autoComplete="off" onFocus={e => e.currentTarget.select()} />
          <div class="mv-actions"><button type="button" disabled={!view.hasCode} onClick={() => setVisible(!visible)}>{t(visible ? 'hide' : 'reveal')}</button>
            <button type="button" disabled={!view.hasCode} onClick={() => { const code = controller.revealCode(); if (code) void copy(code) }}>{t('copy')}</button></div>
          <div class="mv-stack"><button type="button" disabled={!view.hasCode} onClick={() => { const code = controller.revealCode(); if (code) void copy(vaultLink(window.location.href, code)) }}>{t('link')}</button>
            <button ref={importButtonRef} type="button" aria-expanded={importing}
              onClick={() => importing ? closeImport() : setImporting(true)}>{t('importAnother')}</button></div>
          {importForm}
        </div>
      </details>
      <details class="mv-disclosure"><summary>{t('advanced')}</summary><div class="mv-disclosure-body">
        <label>{t('mode')}<select value={mode} onChange={e => setMode(e.currentTarget.value as VaultMode)}>
          <option value="auto">{t('auto')}</option><option value="custom">{t('custom')}</option><option value="off">{t('off')}</option></select></label>
        {mode === 'custom' && <label>{t('room')}<input value={room} maxLength={96}
          aria-invalid={!validVaultRoom(room)} onInput={e => setRoom(e.currentTarget.value)} /></label>}
        <button type="button" disabled={mode === 'custom' && !validVaultRoom(room)} onClick={() => { if (!controller.configure(mode, room)) setNotice(t('invalid')) }}>{t('apply')}</button>
      </div></details>
      {view.hasParts && <p class="mv-parts mv-muted">{t('parts', view.parts)}</p>}
    </>}
    {notice && <p class="mv-notice" role="status">{notice}</p>}
  </section>
}
