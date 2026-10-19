import { describe, expect, it } from 'vitest'
import { captchaDoneUrl, NONCE_RE } from './captcha'
import { browserLabel } from './device'
import { formatBytes, maskSecret } from './format'
import { safeNext } from './nav'
import { passwordStrength } from './password'
import { classifyAssets, detectOS, parseGithubRepo } from './releases'

describe('senha de criptografia', () => {
  it('política do contrato: ≥ 10 caracteres e diferente do e-mail', () => {
    expect(passwordStrength('curta').ok).toBe(false)
    expect(passwordStrength('ana@exemplo.com', 'ana@exemplo.com').ok).toBe(false)
    expect(passwordStrength('1234567890').ok).toBe(false)
    expect(passwordStrength('aaaaaaaaaaaa').ok).toBe(false)
    expect(passwordStrength('senha123456').score).toBeLessThanOrEqual(1)
    const good = passwordStrength('cavalo correto bateria grampo')
    expect(good.ok).toBe(true)
    expect(good.score).toBeGreaterThanOrEqual(3)
  })
})

describe('captcha do app', () => {
  it('URL de retorno com token e nonce no fragmento', () => {
    expect(captchaDoneUrl('https://x.com/cc', 'a.b+c', 'N0nce_-abcdefghijk')).toBe(
      'https://x.com/cc/captcha/done#token=a.b%2Bc&nonce=N0nce_-abcdefghijk'
    )
    expect(NONCE_RE.test('A'.repeat(15))).toBe(false)
    expect(NONCE_RE.test('A'.repeat(16))).toBe(true)
    expect(NONCE_RE.test('abc/def+ghijklmnop')).toBe(false)
  })
})

describe('utilitários', () => {
  it('safeNext só aceita caminhos internos', () => {
    expect(safeNext('/app/providers')).toBe('/app/providers')
    expect(safeNext('//evil.com')).toBe('/app')
    expect(safeNext('https://evil.com')).toBe('/app')
    expect(safeNext(null)).toBe('/app')
    expect(safeNext('/app/chats/abc?x=1#y')).toBe('/app/chats/abc?x=1#y')
    // o parser de URL descarta TAB/LF/CR: "/\t/host" viraria "//host"
    expect(safeNext('/\t/evil.com')).toBe('/app')
    expect(safeNext('/\n/evil.com')).toBe('/app')
    expect(safeNext('/\r/evil.com')).toBe('/app')
    expect(safeNext('/\u0000/evil.com')).toBe('/app')
    expect(safeNext('/ /evil.com')).toBe('/app')
    expect(safeNext('/\\evil.com')).toBe('/app')
    expect(safeNext('/app\u00a0x')).toBe('/app')
  })
  it('formatação', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1,5 KB')
    expect(maskSecret('sk-or-v1-abcdef123456')).toBe('sk-o••••••••3456')
  })
  it('navegador e sistema', () => {
    const ff = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
    expect(browserLabel(ff)).toBe('Firefox no Linux')
    expect(detectOS(ff)).toBe('linux')
    expect(detectOS('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('ios')
  })
  it('releases do GitHub', () => {
    expect(parseGithubRepo('https://github.com/ezenere/ClearChat/releases')).toEqual({
      owner: 'ezenere',
      repo: 'ClearChat'
    })
    expect(parseGithubRepo('https://exemplo.com/downloads')).toBeNull()
    const a = (name: string) => ({ name, browser_download_url: `u/${name}`, size: 1 })
    const r = classifyAssets(
      [
        'x.exe.blockmap',
        'ClearChat Setup 0.6.0.exe',
        'C-0.6.0-arm64.dmg',
        'C-0.6.0.dmg',
        'C.AppImage',
        'c_amd64.deb',
        'c.pacman',
        'c.tar.gz',
        'latest.yml'
      ].map(a)
    )
    expect(r.windows?.name).toBe('ClearChat Setup 0.6.0.exe')
    expect(r.macArm?.name).toBe('C-0.6.0-arm64.dmg')
    expect(r.macX64?.name).toBe('C-0.6.0.dmg')
    expect([r.appImage?.name, r.deb?.name, r.pacman?.name, r.tarGz?.name]).toEqual([
      'C.AppImage',
      'c_amd64.deb',
      'c.pacman',
      'c.tar.gz'
    ])
  })
})
