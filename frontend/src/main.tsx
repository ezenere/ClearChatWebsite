import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initApi } from './api'
import { App } from './App'
import { useSession } from './state/session'

async function start() {
  await initApi()
  void useSession.getState().boot()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start()
