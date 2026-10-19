/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Base relativa ("./"): o mesmo build serve em qualquer caminho de base. O container gera config.js
// (window.__CLEARCHAT__.baseUrl) e o <base href> do index.html no start — ver docker/.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.DEV_BACKEND_URL || 'http://127.0.0.1:8100'
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' },
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
    server: {
      port: 5173,
      // Sem API simulada, o dev server repassa /api e /ws para o backend local (mesma origem).
      proxy:
        env.VITE_MOCK_API === '1'
          ? undefined
          : {
              '/api': { target: backend, changeOrigin: false },
              '/ws': { target: backend.replace(/^http/, 'ws'), ws: true }
            }
    },
    test: {
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      environment: 'node',
      testTimeout: 30_000
    }
  }
})
