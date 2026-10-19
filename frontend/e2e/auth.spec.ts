import { expect, test } from '@playwright/test'
import { DEMO, loginDemo, loginWithCode, mockQuery, unlock } from './helpers'

test('login por código + desbloqueio (senha errada, depois certa)', async ({ page }) => {
  await loginWithCode(page)
  await unlock(page, 'senha-errada-123')
  await expect(page.getByText('Senha incorreta.')).toBeVisible()
  await page.getByLabel('Senha de criptografia').fill(DEMO.password)
  await page.getByRole('button', { name: 'Desbloquear' }).click()
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Refatorar o parser de SSE/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Script de backup com rsync/ })).toBeVisible()
})

test('rota protegida manda para o login e volta ao destino', async ({ page }) => {
  await page.goto('/app/providers')
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fproviders/)
  await page.getByLabel('E-mail').fill(DEMO.email)
  await page.getByRole('button', { name: 'Enviar código' }).click()
  await page.getByLabel('Código de 6 dígitos').fill(DEMO.code)
  await unlock(page)
  await expect(page.getByRole('heading', { name: 'Provedores' })).toBeVisible()
})

test('bloquear e sair', async ({ page }) => {
  await loginDemo(page)
  await page.getByRole('button', { name: 'Bloquear' }).click()
  await unlock(page)
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/app')
  await expect(page).toHaveURL(/\/login/)
})

test('recuperação: chave → senha nova → nova chave de recuperação', async ({ page }) => {
  await loginWithCode(page)
  await expect(page.getByRole('heading', { name: 'Desbloquear seus dados' })).toBeVisible()
  const key = await page.evaluate(() => window.__mock!.server.db.demo!.recovery_key)
  await page.getByRole('link', { name: /usar a chave de recuperação/ }).click()
  // checksum detecta erro de digitação antes da rede
  const typo = key.slice(0, 5) + (key[5] === 'A' ? 'B' : 'A') + key.slice(6)
  await page.getByLabel('Chave de recuperação').fill(typo)
  await page.getByRole('button', { name: 'Recuperar acesso' }).click()
  await expect(page.getByText('Chave de recuperação incorreta')).toBeVisible()
  await page.getByLabel('Chave de recuperação').fill(key.toLowerCase().replace(/-/g, ' '))
  await page.getByRole('button', { name: 'Recuperar acesso' }).click()
  await expect(page.getByRole('heading', { name: 'Defina uma senha nova' })).toBeVisible()
  await page.getByLabel('Nova senha de criptografia').fill('nova frase de senha comprida')
  await page.getByLabel('Confirme a senha').fill('nova frase de senha comprida')
  await page.getByRole('button', { name: 'Salvar nova senha' }).click()
  await expect(page.getByRole('heading', { name: 'Senha trocada' })).toBeVisible({
    timeout: 20_000
  })
  await page.getByRole('button', { name: 'Gerar nova chave de recuperação' }).click()
  const newKey = (
    await page.getByTestId('recovery-key').locator('span.select-all').allTextContents()
  ).join('-')
  expect(newKey).not.toBe(key)
  await page.getByLabel('Guardei minha chave de recuperação em um lugar seguro.').check()
  await page.getByLabel(/4 últimos caracteres/).fill(newKey.slice(-4))
  await page.getByRole('button', { name: 'Guardei — ativar a nova chave' }).click()
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
  // senha antiga não abre mais; a nova sim
  await page.getByRole('button', { name: 'Bloquear' }).click()
  await unlock(page)
  await expect(page.getByText('Senha incorreta.')).toBeVisible()
  await page.getByLabel('Senha de criptografia').fill('nova frase de senha comprida')
  await page.getByRole('button', { name: 'Desbloquear' }).click()
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
})

test('login com captcha exige o Turnstile', async ({ page }) => {
  await page.goto('/login' + mockQuery({ captcha: true }))
  await page.getByLabel('E-mail').fill(DEMO.email)
  const send = page.getByRole('button', { name: 'Enviar código' })
  await expect(send).toBeDisabled()
  await page.getByTestId('fake-turnstile').getByRole('button', { name: 'Não sou um robô' }).click()
  await send.click()
  await expect(page.getByRole('heading', { name: 'Digite o código' })).toBeVisible()
})
