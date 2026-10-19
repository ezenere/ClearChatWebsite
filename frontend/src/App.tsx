import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useSearchParams
} from 'react-router'
import { RotateCw, ServerCrash } from 'lucide-react'
import { basePath } from './api/config'
import { MOCK } from './api'
import { Toaster } from './components/toast'
import { Button, FullPageSpinner } from './components/ui'
import { useSession } from './state/session'
import { MockBar } from './components/MockBar'
import { safeNext } from './lib/nav'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Setup from './pages/Setup'
import Unlock from './pages/Unlock'
import Recover from './pages/Recover'
import Captcha, { CaptchaDone } from './pages/Captcha'
import NotFound from './pages/NotFound'
import PanelLayout from './pages/panel/PanelLayout'
import Chats from './pages/panel/Chats'
import Providers from './pages/panel/Providers'
import Search from './pages/panel/Search'
import Devices from './pages/panel/Devices'
import Security from './pages/panel/Security'
import AccountPage from './pages/panel/Account'
import Instance from './pages/panel/Instance'

const Landing = lazy(() => import('./pages/Landing'))
// markdown (react-markdown + remark-gfm) só carrega ao abrir uma conversa
const ChatView = lazy(() => import('./pages/panel/ChatView'))

function useNextParam(): string {
  const loc = useLocation()
  return encodeURIComponent(loc.pathname + loc.search)
}

/** Exige sessão desbloqueada; senão manda para login / setup / desbloqueio. */
function RequireUnlocked({ children }: { children: ReactNode }) {
  const phase = useSession((s) => s.phase)
  const next = useNextParam()
  if (phase === 'boot') return <FullPageSpinner />
  if (phase === 'anon') return <Navigate to={`/login?next=${next}`} replace />
  if (phase === 'needs_setup') return <Navigate to="/setup" replace />
  if (phase === 'locked') return <Navigate to={`/unlock?next=${next}`} replace />
  return <>{children}</>
}

/** Páginas de entrada: quem já está logado segue adiante. */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const phase = useSession((s) => s.phase)
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  if (phase === 'boot') return <FullPageSpinner />
  if (phase === 'unlocked') return <Navigate to={next} replace />
  if (phase === 'locked')
    return <Navigate to={`/unlock?next=${encodeURIComponent(next)}`} replace />
  if (phase === 'needs_setup') return <Navigate to="/setup" replace />
  return <>{children}</>
}

function Home() {
  const info = useSession((s) => s.info)
  if (!info) return <FullPageSpinner />
  if (info.features.landing)
    return (
      <Suspense fallback={<FullPageSpinner />}>
        <Landing />
      </Suspense>
    )
  return <Navigate to="/app" replace />
}

function InfoGate() {
  const { info, infoError, loadInfo } = useSession()
  if (!info && infoError)
    return (
      <div className="flex min-h-dvh items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-elevated text-danger">
            <ServerCrash className="size-6" />
          </div>
          <h1 className="text-lg font-semibold">Servidor indisponível</h1>
          <p className="mt-2 text-sm text-muted">{infoError}</p>
          <Button
            className="mt-5"
            icon={<RotateCw className="size-4" />}
            onClick={() => loadInfo()}
          >
            Tentar de novo
          </Button>
        </div>
      </div>
    )
  return <Outlet />
}

/** Bloqueio automático por inatividade (a DEK sai da memória). */
const IDLE_LOCK_MS = 15 * 60_000
function IdleLock() {
  const phase = useSession((s) => s.phase)
  useEffect(() => {
    if (phase !== 'unlocked') return
    const touch = () => useSession.getState().touch()
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove']
    let last = 0
    const throttled = () => {
      const now = Date.now()
      if (now - last > 5000) {
        last = now
        touch()
      }
    }
    events.forEach((e) => window.addEventListener(e, throttled, { passive: true }))
    const timer = setInterval(() => {
      const s = useSession.getState()
      if (s.phase === 'unlocked' && Date.now() - s.lastActivity > IDLE_LOCK_MS) s.lock('idle')
    }, 15_000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, throttled))
      clearInterval(timer)
    }
  }, [phase])
  return null
}

function Root() {
  return (
    <>
      <InfoGate />
      <IdleLock />
      <Toaster />
      {MOCK && <MockBar />}
    </>
  )
}

const router = createBrowserRouter(
  [
    {
      element: <Root />,
      children: [
        { path: '/', element: <Home /> },
        {
          path: '/login',
          element: (
            <RedirectIfAuthed>
              <Login />
            </RedirectIfAuthed>
          )
        },
        { path: '/signup', element: <Signup /> },
        { path: '/setup', element: <Setup /> },
        { path: '/unlock', element: <Unlock /> },
        { path: '/recover', element: <Recover /> },
        { path: '/captcha', element: <Captcha /> },
        { path: '/captcha/done', element: <CaptchaDone /> },
        {
          path: '/app',
          element: (
            <RequireUnlocked>
              <PanelLayout />
            </RequireUnlocked>
          ),
          children: [
            { index: true, element: <Chats /> },
            {
              path: 'chats/:chatId',
              element: (
                <Suspense fallback={<FullPageSpinner />}>
                  <ChatView />
                </Suspense>
              )
            },
            { path: 'providers', element: <Providers /> },
            { path: 'search', element: <Search /> },
            { path: 'devices', element: <Devices /> },
            { path: 'security', element: <Security /> },
            { path: 'account', element: <AccountPage /> },
            { path: 'instance', element: <Instance /> }
          ]
        },
        { path: '*', element: <NotFound /> }
      ]
    }
  ],
  { basename: basePath() || undefined }
)

export function App() {
  return <RouterProvider router={router} />
}
