import { expect, test } from '@playwright/test'
import { mockGithub, mockQuery } from './helpers'

test('landing apresenta o app, downloads da última release e links', async ({ page }) => {
  await mockGithub(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('mostra tudo')
  for (const t of [
    'Qualquer provedor',
    'Ferramentas com aprovação',
    'Subagentes',
    'Memória modular',
    'Skills',
    'Sync ponta a ponta',
    'Self-host'
  ])
    await expect(page.getByRole('heading', { name: t, exact: true })).toBeVisible()
  const dl = page.locator('#download')
  await expect(dl.getByRole('link', { name: /Instalador/ })).toHaveAttribute(
    'href',
    /setup-x64\.exe$/
  )
  await expect(dl.getByRole('link', { name: /Apple Silicon/ })).toHaveAttribute(
    'href',
    /arm64\.dmg$/
  )
  await expect(dl.getByRole('link', { name: /^Intel/ })).toHaveAttribute('href', /x64\.dmg$/)
  await expect(dl.getByRole('link', { name: /AppImage/ })).toHaveAttribute('href', /\.AppImage$/)
  await expect(dl.getByRole('link', { name: /\.deb/ })).toHaveAttribute('href', /\.deb$/)
  await expect(dl.getByRole('link', { name: /pacman/ })).toHaveAttribute('href', /\.pacman$/)
  await expect(dl.getByRole('link', { name: /^\.tar\.gz/ })).toHaveAttribute('href', /\.tar\.gz$/)
  await expect(dl).toContainText('v0.6.0')
  await expect(page.getByRole('link', { name: 'GitHub' }).first()).toHaveAttribute(
    'href',
    'https://github.com/ezenere/ClearChat'
  )
  // galeria de capturas
  await page.getByRole('tab', { name: /Questionário do agente/ }).click()
  await expect(page.getByRole('img', { name: /Questionário do agente/ })).toBeVisible()
  await page.getByRole('banner').getByRole('link', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/signup$/)
})

test('GitHub fora do ar: links caem na página de releases', async ({ page }) => {
  await page.route('https://api.github.com/**', (r) => r.fulfill({ status: 503, body: '' }))
  await page.goto('/')
  await expect(page.locator('#download').getByRole('link', { name: /Instalador/ })).toHaveAttribute(
    'href',
    'https://github.com/ezenere/ClearChat/releases/latest'
  )
})

test('landing desligada: a raiz leva ao login', async ({ page }) => {
  await page.goto('/' + mockQuery({ landing: false }))
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('heading', { name: /Entrar em/ })).toBeVisible()
})

test('cadastro fechado sem convite', async ({ page }) => {
  await page.goto('/signup' + mockQuery({ signup: false }))
  await expect(page.getByRole('heading', { name: 'Cadastro fechado' })).toBeVisible()
  await page.goto('/login')
  await expect(page.getByRole('link', { name: 'Criar conta' })).toHaveCount(0)
})
