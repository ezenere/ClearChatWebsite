import { defineConfig, devices } from '@playwright/test'

// E2E contra a API SIMULADA (src/mock): `vite --mode mock`. Sem backend.
const PORT = 5199

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['basepath/**'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
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
  webServer: {
    command: `npx vite --mode mock --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
})
