import { defineConfig, devices } from '@playwright/test'

// E2E de INTEGRAÇÃO: o site (dev server do Vite, sem mock) contra um backend REAL.
// CLEARCHAT_IT_BACKEND_URL=http://127.0.0.1:8100 (a api; o Vite repassa /api e /ws para ela)
// CLEARCHAT_IT_MAIL_LOG=/caminho/api.log (log da api com MAIL_BACKEND=console: de onde sai o código)
// Sem CLEARCHAT_IT_BACKEND_URL os testes são pulados.
const PORT = Number(process.env.CLEARCHAT_IT_WEB_PORT || 5198)
const backend = process.env.CLEARCHAT_IT_BACKEND_URL

export default defineConfig({
  testDir: './e2e-integration',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write']
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } }
    }
  ],
  webServer: backend
    ? {
        command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
        env: { DEV_BACKEND_URL: backend },
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000
      }
    : undefined
})
