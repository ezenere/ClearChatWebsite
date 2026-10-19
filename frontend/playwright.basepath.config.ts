import { defineConfig, devices } from '@playwright/test'

// Build de produção (modo mock) servido sob /clearchat — valida caminho de base em tempo de execução.
const PORT = 5198

export default defineConfig({
  testDir: './e2e/basepath',
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: 'pt-BR', ...devices['Desktop Chrome'] },
  webServer: {
    command: `npm run build:mock && node e2e/basepath/serve.mjs`,
    url: `http://127.0.0.1:${PORT}/clearchat/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000
  }
})
