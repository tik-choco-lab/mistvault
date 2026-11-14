import { describe, expect, it, vi } from 'vitest'
import { canonicalizeVaultCode, consumeVaultLink, generateVaultCode, parseVaultCode, vaultLink, VAULT_CODE_RE } from './code.js'

describe('vault codes', () => {
  it('encodes exactly 128 random bits using canonical base32', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      new Uint8Array((array as Uint8Array).buffer).fill(255); return array
    })
    try { expect(generateVaultCode()).toBe('tcv1-77777777777777777777777774') } finally { spy.mockRestore() }
    const a = generateVaultCode(), b = generateVaultCode()
    expect(a).toMatch(VAULT_CODE_RE); expect(parseVaultCode(a)).toBe(a); expect(a).not.toBe(b)
  })
  it('canonicalizes case and grouping only after the prefix', () => {
    expect(canonicalizeVaultCode(' TCV1-AAAA AAAA-AAAA AAAA-AAAA AAAA-AA ')).toBe('tcv1-' + 'a'.repeat(26))
    expect(parseVaultCode('tcv1-' + 'a'.repeat(25) + 'b')).toBeNull()
    expect(parseVaultCode('tcv1-' + 'a'.repeat(25) + '4')).toBe('tcv1-' + 'a'.repeat(25) + '4')
    for (const input of [null, 1, '', 'tcv1' + 'a'.repeat(26), 'tcv1-' + 'a'.repeat(25), 'tcv1-' + '0'.repeat(26)]) expect(parseVaultCode(input)).toBeNull()
    expect(() => canonicalizeVaultCode('bad')).toThrow()
  })
  it('removes only the device-link fragment parameter without importing', () => {
    const code = 'tcv1-' + 'a'.repeat(26), replaceState = vi.fn()
    expect(vaultLink('https://example.org/app?q=x#old', code)).toBe('https://example.org/app?q=x#tc-vault=' + code)
    expect(consumeVaultLink({ href: 'https://example.org/app#tc-vault=' + code + '&other=1' }, { state: { n: 1 }, replaceState })).toBe(code)
    expect(replaceState).toHaveBeenCalledWith({ n: 1 }, '', 'https://example.org/app#other=1')
    expect(consumeVaultLink({ href: 'https://example.org/#tc-vault=bad' }, { state: null, replaceState })).toBeNull()
    expect(replaceState).toHaveBeenLastCalledWith(null, '', 'https://example.org/')
  })
})
