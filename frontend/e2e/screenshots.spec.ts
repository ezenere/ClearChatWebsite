// Capturas de todas as telas em largura de desktop e de celular → e2e/screenshots/.
import { expect, test, type Page } from '@playwright/test'
import { DEMO, loginDemo, mockGithub, mockQuery } from './helpers'

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
]

/** Nada pode vazar para a direita (fora de contêineres com rolagem própria). */
async function expectNoHorizontalOverflow(page: Page, name: string) {
  const offenders = await page.evaluate(() => {
    const W = document.documentElement.clientWidth
    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p && !p.hasAttribute('data-page-root'); p = p.parentElement) {
        const o = getComputedStyle(p).overflowX
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true
      }
      return false
    }
    return [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.right > W + 1 && !el.closest('[aria-hidden]') && !clipped(el)
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`)
  })
  expect(offenders, `overflow horizontal em ${name}`).toEqual([])
}

async function shot(page: Page, size: string, name: string, fullPage = true) {
  await page.waitForTimeout(250) // animações de entrada
  await expectNoHorizontalOverflow(page, name)
  await page.screenshot({ path: `e2e/screenshots/${size}/${name}.png`, fullPage })
}

for (const s of SIZES) {
  test.describe(s.name, () => {
    test.use({
      viewport: { width: s.width, height: s.height },
      deviceScaleFactor: s.name === 'mobile' ? 2 : 1
    })

    test('páginas públicas e de autenticação', async ({ page }) => {
      await mockGithub(page)
      await page.goto('/')
      await expect(page.locator('#download')).toContainText('v0.6.0')
      // carrega as imagens "lazy"
      for (let y = 0; y < 9000; y += 600) await page.mouse.wheel(0, 600)
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => window.scrollTo(0, 0))
      await shot(page, s.name, '01-landing')
      if (s.name === 'mobile') {
        await page.getByRole('button', { name: 'Menu' }).click()
        await shot(page, s.name, '01b-landing-menu', false)
      }

      await page.goto('/login')
      await page.getByLabel('E-mail').fill(DEMO.email)
      await shot(page, s.name, '02-login')
      await page.getByRole('button', { name: 'Enviar código' }).click()
      await expect(page.getByRole('heading', { name: 'Digite o código' })).toBeVisible()
      await shot(page, s.name, '03-login-codigo')
      await page.getByLabel('Código de 6 dígitos').fill(DEMO.code)
      await expect(page.getByRole('heading', { name: 'Desbloquear seus dados' })).toBeVisible()
      await shot(page, s.name, '04-desbloquear')
      await page.getByRole('link', { name: /usar a chave de recuperação/ }).click()
      await shot(page, s.name, '05-recuperar')
    })

    test('cadastro', async ({ page }) => {
      await page.goto('/signup' + mockQuery({ captcha: true }))
      await page.getByLabel('Nome').fill('Bruno Teste')
      await page.getByLabel('E-mail').fill('bruno@exemplo.com')
      await shot(page, s.name, '06-cadastro')
      await page.getByTestId('fake-turnstile').getByRole('button').click()
      await page.getByRole('button', { name: 'Continuar' }).click()
      await page.getByLabel('Código de 6 dígitos').fill(DEMO.code)
      await page.getByLabel('Senha de criptografia', { exact: true }).fill('cavalo correto bateria')
      await page.getByLabel('Confirme a senha').fill('cavalo correto bateria')
      await shot(page, s.name, '07-cadastro-senha')
      await page.getByRole('button', { name: 'Gerar chaves' }).click()
      await expect(page.getByTestId('recovery-key')).toBeVisible({ timeout: 20_000 })
      await shot(page, s.name, '08-cadastro-chave-de-recuperacao')
      const key = (
        await page.getByTestId('recovery-key').locator('span.select-all').allTextContents()
      ).join('')
      await page.getByLabel('Guardei minha chave de recuperação em um lugar seguro.').check()
      await page.getByLabel(/4 últimos caracteres/).fill(key.slice(-4))
      await page.getByRole('button', { name: 'Guardei — concluir' }).click()
      await expect(page.getByRole('heading', { name: 'Tudo pronto' })).toBeVisible()
      await shot(page, s.name, '09-cadastro-pronto')
    })

    test('captcha do app', async ({ page }) => {
      await page.goto(
        '/captcha?client=app&nonce=Abc123_-xyzXYZ0987654321&action=login&mock_captcha=1'
      )
      await expect(page.getByTestId('fake-turnstile')).toBeVisible()
      await shot(page, s.name, '10-captcha', false)
    })

    test('painel', async ({ page }) => {
      await loginDemo(page)
      await shot(page, s.name, '11-painel-conversas')
      await page.getByRole('link', { name: /Refatorar o parser de SSE/ }).click()
      await page.getByRole('button', { name: /shell/ }).click()
      await shot(page, s.name, '12-painel-conversa')
      if (s.name === 'mobile') {
        await page.getByRole('button', { name: 'Abrir menu' }).click()
        await shot(page, s.name, '12b-painel-menu', false)
        await page.getByRole('button', { name: 'Fechar menu' }).click()
      }
      const go = async (label: string) => {
        if (s.name === 'mobile') await page.getByRole('button', { name: 'Abrir menu' }).click()
        await page.getByRole('link', { name: label, exact: true }).click()
      }
      await go('Provedores')
      await expect(page.getByTestId('provider-card')).toHaveCount(3)
      await shot(page, s.name, '13-painel-provedores')
      await page.getByRole('button', { name: 'Editar OpenRouter' }).click()
      await shot(page, s.name, '14-painel-provedor-editar', false)
      await page.keyboard.press('Escape')
      await go('Pesquisa na web')
      await expect(page.getByLabel('Exa')).toBeVisible()
      await shot(page, s.name, '15-painel-pesquisa')
      await go('Dispositivos')
      await expect(page.getByTestId('device-row')).toHaveCount(3)
      await shot(page, s.name, '16-painel-dispositivos')
      await go('Segurança')
      await shot(page, s.name, '17-painel-seguranca')
      await go('Conta')
      await expect(page.getByText('Registros')).toBeVisible()
      await shot(page, s.name, '18-painel-conta')
      await go('Instância')
      await shot(page, s.name, '19-painel-instancia')
    })
  })
}
