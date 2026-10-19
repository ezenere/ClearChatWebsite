import { expect, type Page } from '@playwright/test'

export const DEMO = { email: 'demo@clearchat.dev', password: 'demonstracao-segura', code: '123456' }

/** Release falsa do GitHub (sem depender da rede nos testes). */
export async function mockGithub(page: Page): Promise<void> {
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      json: {
        tag_name: 'v0.6.0',
        html_url: 'https://github.com/ezenere/ClearChat/releases/tag/v0.6.0',
        published_at: '2026-10-15T12:00:00Z',
        assets: [
          'ClearChat-0.6.0-setup-x64.exe',
          'ClearChat-0.6.0-setup-x64.exe.blockmap',
          'ClearChat-0.6.0-arm64.dmg',
          'ClearChat-0.6.0-x64.dmg',
          'ClearChat-0.6.0-x86_64.AppImage',
          'ClearChat-0.6.0-amd64.deb',
          'ClearChat-0.6.0-x64.pacman',
          'ClearChat-0.6.0-x64.tar.gz',
          'latest.yml'
        ].map((name, i) => ({
          name,
          size: 100_000_000 + i * 1_000_000,
          browser_download_url: `https://github.com/ezenere/ClearChat/releases/download/v0.6.0/${name}`
        }))
      }
    })
  )
}

/** Configura a instância simulada antes do primeiro carregamento. */
export function mockQuery(
  opts: { landing?: boolean; signup?: boolean; captcha?: boolean } = {}
): string {
  const p = new URLSearchParams()
  if (opts.landing !== undefined) p.set('mock_landing', opts.landing ? '1' : '0')
  if (opts.signup !== undefined) p.set('mock_signup', opts.signup ? '1' : '0')
  if (opts.captcha !== undefined) p.set('mock_captcha', opts.captcha ? '1' : '0')
  const s = p.toString()
  return s ? `?${s}` : ''
}

export async function loginWithCode(page: Page, email = DEMO.email): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('E-mail').fill(email)
  await page.getByRole('button', { name: 'Enviar código' }).click()
  await expect(page.getByRole('heading', { name: 'Digite o código' })).toBeVisible()
  await page.getByLabel('Código de 6 dígitos').fill(DEMO.code)
}

export async function unlock(page: Page, password = DEMO.password): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Desbloquear seus dados' })).toBeVisible()
  await page.getByLabel('Senha de criptografia').fill(password)
  await page.getByRole('button', { name: 'Desbloquear' }).click()
}

export async function loginDemo(page: Page): Promise<void> {
  await loginWithCode(page)
  await unlock(page)
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
}
