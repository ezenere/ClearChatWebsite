import { expect, test } from '@playwright/test'
import { mockQuery } from './helpers'

const NONCE = 'Abc123_-xyzXYZ0987654321'

test('handshake do captcha do app: /captcha → /captcha/done#token=…&nonce=…', async ({ page }) => {
  await page.goto('/' + mockQuery({ captcha: true }))
  await page.goto(`/captcha?client=app&nonce=${NONCE}&action=signup`)
  await expect(page.getByRole('heading', { name: /Confirme que você é humano/ })).toBeVisible()
  await expect(page.getByText('Para criar a conta')).toBeVisible()
  const nav = page.waitForURL(/\/captcha\/done#/)
  await page.getByTestId('fake-turnstile').getByRole('button', { name: 'Não sou um robô' }).click()
  await nav
  const url = new URL(page.url())
  expect(url.pathname).toBe('/captcha/done')
  expect(url.search).toBe('')
  const frag = new URLSearchParams(url.hash.slice(1))
  expect(frag.get('nonce')).toBe(NONCE)
  // o widget recebeu action e cData = nonce
  expect(frag.get('token')).toMatch(new RegExp(`^mock-turnstile\\.signup\\.${NONCE}\\.`))
  await expect(page.getByRole('heading', { name: 'Verificação concluída' })).toBeVisible()
})

test('captcha: nonce inválido e instância sem captcha', async ({ page }) => {
  await page.goto('/captcha?client=app&nonce=curto&action=login' + '&mock_captcha=1')
  await expect(page.getByRole('heading', { name: 'Link de verificação inválido' })).toBeVisible()
  await page.goto(`/captcha?client=app&nonce=${NONCE}&action=login&mock_captcha=0`)
  await expect(page.getByRole('heading', { name: 'Sem verificação nesta instância' })).toBeVisible()
})
