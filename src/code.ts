const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
export const VAULT_CODE_RE = /^tcv1-[a-z2-7]{26}$/
export function generateVaultCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let value = 0, bits = 0, result = 'tcv1-'
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31] }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31]
  return result
}
export function parseVaultCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim().toLowerCase()
  if (!text.startsWith('tcv1-')) return null
  const code = 'tcv1-' + text.slice(5).replace(/[\s-]/g, '')
  // 128 bits use only the top three bits of the final base32 character.
  return VAULT_CODE_RE.test(code) && (alphabet.indexOf(code.at(-1)!) & 3) === 0 ? code : null
}
export function canonicalizeVaultCode(input: string): string {
  const code = parseVaultCode(input)
  if (!code) throw new Error('Invalid vault code')
  return code
}
export function vaultLink(url: string, code: string): string {
  const target = new URL(url)
  target.hash = 'tc-vault=' + canonicalizeVaultCode(code)
  return target.href
}
/** Removes a device-link secret immediately; callers must ask before importing it. */
export function consumeVaultLink(location: Pick<Location, 'href'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history): string | null {
  const url = new URL(location.href), params = new URLSearchParams(url.hash.slice(1))
  if (!params.has('tc-vault')) return null
  const code = parseVaultCode(params.get('tc-vault'))
  params.delete('tc-vault'); url.hash = params.toString()
  history.replaceState(history.state, '', url.href)
  return code
}
