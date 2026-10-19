import { expect, test } from '@playwright/test'
import { DEMO } from '../helpers'

test('build servido em sub-caminho (/clearchat): deep link, login, desbloqueio (worker) e painel', async ({
  page
}) => {
  await page.goto('/clearchat/app/providers')
  await expect(page).toHaveURL(/\/clearchat\/login\?next=%2Fapp%2Fproviders/)
  await page.getByLabel('E-mail').fill(DEMO.email)
  await page.getByRole('button', { name: 'Enviar código' }).click()
  await page.getByLabel('Código de 6 dígitos').fill(DEMO.code)
  await page.getByLabel('Senha de criptografia').fill(DEMO.password)
  await page.getByRole('button', { name: 'Desbloquear' }).click()
  await expect(page).toHaveURL(/\/clearchat\/app\/providers$/)
  await expect(page.getByTestId('provider-card')).toHaveCount(3)
  await page.getByRole('link', { name: 'Conversas', exact: true }).click()
  await expect(page).toHaveURL(/\/clearchat\/app$/)
  // âncora interna da landing não sai da página
  await page.goto('/clearchat/?utm=x')
  await page.getByRole('banner').getByRole('link', { name: 'Download' }).click()
  await expect(page).toHaveURL(/\/clearchat\/\?utm=x#download$/)
  // captcha do app volta para <base>/captcha/done
  await page.goto(
    '/clearchat/captcha?client=app&nonce=Abc123_-xyzXYZ0987654321&action=login&mock_captcha=1'
  )
  await page.getByTestId('fake-turnstile').getByRole('button').click()
  await page.waitForURL(/\/clearchat\/captcha\/done#token=/)
})
