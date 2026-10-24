// Página inicial (só com `features.landing`): apresenta o ClearChat, downloads e self-host.
// Os efeitos e as demos interativas ficam em ./landing/.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import {
  ArrowRight,
  AudioLines,
  Bot,
  Boxes,
  Brain,
  Check,
  Cloud,
  Cpu,
  Download,
  Eye,
  Globe,
  HandMetal,
  KeyRound,
  Laptop,
  Menu,
  Mic,
  MousePointer2,
  PhoneOff,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  UserRound,
  X,
  Zap
} from 'lucide-react'
import { AppIcon, Wordmark } from '../components/Logo'
import { Button, CopyButton, cx } from '../components/ui'
import { formatBytes, formatDate } from '../lib/format'
import {
  type Asset,
  DEFAULT_RELEASES,
  detectOS,
  fetchLatestRelease,
  type OS,
  type Release
} from '../lib/releases'
import { useSession } from '../state/session'
import { Orb } from './landing/Orb'
import { CallTicker } from './landing/CallTicker'
import { VoiceLab } from './landing/VoiceLab'
import { ApprovalDemo } from './landing/ApprovalDemo'
import { RequestInspector } from './landing/RequestInspector'
import { CryptoPlayground } from './landing/CryptoPlayground'
import { CursorGlow, Marquee, SpotCard, Tilt } from './landing/fx'
import { useReveal } from './landing/hooks'
import './landing/landing.css'
import shotChat from '../assets/screenshots/chat.webp'
import shotQueue from '../assets/screenshots/aprovacoes-fila.webp'
import shotAsk from '../assets/screenshots/questionario.webp'
import shotLists from '../assets/screenshots/configuracoes-aprovacoes.webp'
import shotMemory from '../assets/screenshots/memoria.webp'
import shotCall from '../assets/screenshots/voz-chamada.webp'
import shotDictation from '../assets/screenshots/composer-ditado.webp'
import shotVoiceSettings from '../assets/screenshots/voz-configuracoes.webp'
import shotGpu from '../assets/screenshots/modelos-locais-gpu.webp'
import shotPersona from '../assets/screenshots/personas.webp'

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

const REPO_URL = 'https://github.com/ezenere/ClearChat'
const SERVER_REPO_URL = 'https://github.com/ezenere/ClearChatWebsite'

const STACK = [
  'OpenRouter',
  'Anthropic',
  'OpenAI-compatible',
  'ElevenLabs',
  'Groq',
  'Kokoro',
  'whisper.cpp',
  'XTTS-v2',
  'OmniVoice',
  'Qwen3-TTS',
  'VibeVoice',
  'faster-whisper',
  'Agent Skills',
  'DuckDuckGo',
  'Brave',
  'Exa',
  'Tavily'
]

const VOICE: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <Mic className="size-4" />,
    title: 'Chamada e ditado',
    text: 'Ligue de dentro de qualquer chat, ou dite no campo de mensagem e veja o texto surgir enquanto fala.'
  },
  {
    icon: <AudioLines className="size-4" />,
    title: 'Soa como gente',
    text: '“Hmm, deixa eu ver aqui…” enquanto o modelo pensa — e um “desculpe a demora” se a resposta atrasar.'
  },
  {
    icon: <UserRound className="size-4" />,
    title: 'Voz por persona',
    text: 'Cada persona com a sua voz, o seu modelo e um prompt extra só para chamadas — ou sem chamadas.'
  },
  {
    icon: <PhoneOff className="size-4" />,
    title: 'Ele sabe desligar',
    text: 'O agente encerra a chamada quando a conversa termina. Chamadas e mensagens de voz ficam marcadas no chat.'
  },
  {
    icon: <Cloud className="size-4" />,
    title: 'Na nuvem ou 100% local',
    text: 'ElevenLabs (inclusive por WebSocket), OpenRouter e Groq — ou Kokoro e whisper.cpp na CPU, offline.'
  },
  {
    icon: <Cpu className="size-4" />,
    title: 'Modo avançado na GPU',
    text: 'XTTS-v2, OmniVoice, Qwen3-TTS, VibeVoice e faster-whisper sob demanda, com checagem do hardware e vozes clonadas.'
  }
]

const FEATURES: { icon: ReactNode; title: string; text: string; wide?: boolean }[] = [
  {
    icon: <Sparkles className="size-5" />,
    title: 'Qualquer provedor',
    text: 'OpenAI-compatible, OpenRouter e Anthropic nativa. Parâmetros que o modelo não aceita somem do painel e não vão na request.',
    wide: true
  },
  {
    icon: <HandMetal className="size-5" />,
    title: 'Ferramentas com aprovação',
    text: 'Shell, arquivos, processos, navegador e busca na web — cada uma com a sua política.'
  },
  {
    icon: <Bot className="size-5" />,
    title: 'Subagentes',
    text: 'Em paralelo, com modelo próprio e em segundo plano — acordam o agente principal ao terminar.'
  },
  {
    icon: <Brain className="size-5" />,
    title: 'Memória modular',
    text: 'Coleções por categoria (perfil, tópicos, pessoas…), ativadas por chat ou persona.'
  },
  {
    icon: <Boxes className="size-5" />,
    title: 'Skills',
    text: 'Formato Agent Skills (pasta com SKILL.md): carregadas sob demanda, sem inflar o contexto.'
  },
  {
    icon: <Eye className="size-5" />,
    title: 'Transparência total',
    text: '"Ver request" mostra o body exato enviado. Custo, tokens e cache em cada resposta.',
    wide: true
  },
  {
    icon: <UserRound className="size-5" />,
    title: 'Personas',
    text: 'Prompt, modelo, memórias e voz por persona. Troque de especialista em um clique.'
  },
  {
    icon: <Globe className="size-5" />,
    title: 'Pesquisa na web',
    text: 'DuckDuckGo, Brave, Exa e Tavily, com ordem e fallback configuráveis.'
  },
  {
    icon: <ShieldCheck className="size-5" />,
    title: 'Sync ponta a ponta',
    text: 'Conversas, provedores e memórias em todos os dispositivos — cifrados antes de sair deles.'
  },
  {
    icon: <Server className="size-5" />,
    title: 'Self-host',
    text: 'Rode o seu servidor de sync com Docker Compose. O app conecta em qualquer instância.'
  }
]

const SHOTS: { src: string; title: string; text: string; group: 'Voz' | 'Agente' }[] = [
  {
    src: shotCall,
    group: 'Voz',
    title: 'Chamada de voz',
    text: 'O agente roda o terminal enquanto vocês conversam; a chamada fica marcada no chat.'
  },
  {
    src: shotDictation,
    group: 'Voz',
    title: 'Ditado',
    text: 'O texto aparece enquanto você fala, direto no campo de mensagem.'
  },
  {
    src: shotVoiceSettings,
    group: 'Voz',
    title: 'Vozes e parâmetros',
    text: 'ElevenLabs por WebSocket, formato de saída e voice settings — tudo exposto.'
  },
  {
    src: shotGpu,
    group: 'Voz',
    title: 'Modelos locais na GPU',
    text: 'Checagem do hardware, motores sob demanda e o servidor local que se desliga sozinho.'
  },
  {
    src: shotPersona,
    group: 'Voz',
    title: 'Voz por persona',
    text: 'Modelo da chamada, prompt complementar e se o agente pode desligar.'
  },
  {
    src: shotChat,
    group: 'Agente',
    title: 'Chat com agente',
    text: 'Shell aguardando aprovação, comando a comando.'
  },
  {
    src: shotQueue,
    group: 'Agente',
    title: 'Fila de aprovações',
    text: 'Vários subagentes pedindo ao mesmo tempo: "1 de 3", um de cada vez.'
  },
  {
    src: shotAsk,
    group: 'Agente',
    title: 'Questionário do agente',
    text: 'O agente pergunta com opções, ícones e imagens — sempre há "Outro".'
  },
  {
    src: shotLists,
    group: 'Agente',
    title: 'Whitelist e blacklist',
    text: 'Teste um comando e veja o veredito de cada sub-comando de `a && b | c`.'
  },
  {
    src: shotMemory,
    group: 'Agente',
    title: 'Memória',
    text: 'Ferramentas de busca e gravação no chat e o painel de coleções.'
  }
]

/** `trechos entre crases` viram <code>. */
function withCode(text: string): ReactNode {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <code
        key={i}
        className="rounded border border-border bg-elevated px-1 py-px font-mono text-[0.88em] text-[#e9d5ff]"
      >
        {part}
      </code>
    ) : (
      part
    )
  )
}

function Section({
  id,
  index,
  eyebrow,
  title,
  intro,
  children,
  className
}: {
  id?: string
  index: string
  eyebrow: string
  title: ReactNode
  intro?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={cx('relative scroll-mt-16 px-4 py-20 sm:px-8 sm:py-28', className)}>
      <div className="mx-auto max-w-6xl">
        <p
          data-reveal
          className="flex items-center gap-3 font-mono text-[12px] tracking-[0.18em] text-accent-strong uppercase"
        >
          <span className="text-faint">{index}</span>
          <span className="h-px w-8 bg-accent/50" />
          {eyebrow}
        </p>
        <h2
          data-reveal
          className="mt-4 max-w-3xl text-[30px] leading-[1.08] font-semibold tracking-[-0.03em] text-balance sm:text-[46px]"
        >
          {title}
        </h2>
        {intro && (
          <p
            data-reveal
            className="mt-5 max-w-2xl text-[15.5px] leading-relaxed text-muted sm:text-[17px]"
          >
            {intro}
          </p>
        )}
        <div className="mt-12 sm:mt-16">{children}</div>
      </div>
    </section>
  )
}

function WindowFrame({
  src,
  alt,
  className,
  eager
}: {
  src: string
  alt: string
  className?: string
  eager?: boolean
}) {
  return (
    <div
      className={cx(
        'overflow-hidden rounded-xl border border-border-strong bg-surface shadow-modal',
        className
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-elevated px-3 py-2">
        <span className="size-2.5 rounded-full bg-[#3a3a44]" />
        <span className="size-2.5 rounded-full bg-[#3a3a44]" />
        <span className="size-2.5 rounded-full bg-[#3a3a44]" />
      </div>
      <img
        src={src}
        alt={alt}
        width={1600}
        height={975}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className="block h-auto w-full"
      />
    </div>
  )
}

function osLabel(os: OS): string {
  return os === 'windows' ? 'Windows' : os === 'mac' ? 'macOS' : os === 'linux' ? 'Linux' : ''
}

function primaryAsset(os: OS, r: Release | null): Asset | undefined {
  if (!r) return undefined
  if (os === 'windows') return r.windows
  if (os === 'mac') return r.macArm ?? r.macX64
  if (os === 'linux') return r.appImage ?? r.deb
  return undefined
}

function DownloadCta({
  os,
  release,
  downloadUrl,
  center
}: {
  os: OS
  release: Release | null
  downloadUrl: string
  center?: boolean
}) {
  const desktop = os === 'windows' || os === 'mac' || os === 'linux'
  const asset = primaryAsset(os, release)
  const href = asset?.url ?? release?.pageUrl ?? downloadUrl
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-3 sm:flex-row sm:justify-center',
        !center && 'lg:justify-start'
      )}
    >
      <a
        href={desktop ? href : '#download'}
        className="glow-ring w-full rounded-lg sm:w-auto"
        {...(desktop ? { rel: 'noopener' } : {})}
      >
        <Button
          variant="primary"
          size="lg"
          className="w-full sm:w-auto"
          icon={<Download className="size-4" />}
        >
          {desktop ? `Baixar para ${osLabel(os)}` : 'Baixar o app'}
        </Button>
      </a>
      <a href="#download" className="w-full sm:w-auto">
        <Button
          size="lg"
          variant="secondary"
          className="w-full bg-elevated/60 backdrop-blur sm:w-auto"
        >
          Todas as plataformas
        </Button>
      </a>
    </div>
  )
}

function AssetLink({ asset, label, fallback }: { asset?: Asset; label: string; fallback: string }) {
  return (
    <a
      href={asset?.url ?? fallback}
      rel="noopener"
      className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-bg/50 px-3 py-2.5 text-sm transition-colors hover:border-accent/40 hover:bg-accent-soft"
    >
      <span className="min-w-0">
        <span className="block font-medium text-fg">{label}</span>
        <span className="block truncate font-mono text-[11.5px] text-subtle">
          {asset ? `${asset.name} · ${formatBytes(asset.size)}` : 'na página de releases'}
        </span>
      </span>
      <Download className="size-4 shrink-0 text-subtle transition-transform group-hover:translate-y-0.5 group-hover:text-accent-strong" />
    </a>
  )
}

function Downloads({
  release,
  downloadUrl,
  os
}: {
  release: Release | null
  downloadUrl: string
  os: OS
}) {
  const page = release?.pageUrl ?? downloadUrl
  const cards = [
    {
      os: 'windows' as const,
      title: 'Windows',
      note: 'Instalador .exe (x64)',
      links: [{ label: 'Instalador', asset: release?.windows }]
    },
    {
      os: 'mac' as const,
      title: 'macOS',
      note: 'Imagem .dmg',
      links: [
        { label: 'Apple Silicon (M1+)', asset: release?.macArm },
        { label: 'Intel', asset: release?.macX64 }
      ]
    },
    {
      os: 'linux' as const,
      title: 'Linux',
      note: 'AppImage, .deb, pacman e .tar.gz',
      links: [
        { label: 'AppImage', asset: release?.appImage },
        { label: 'Debian / Ubuntu (.deb)', asset: release?.deb },
        { label: 'Arch (pacman)', asset: release?.pacman },
        { label: '.tar.gz', asset: release?.tarGz }
      ]
    }
  ]
  return (
    <>
      {(os === 'android' || os === 'ios') && (
        <p className="mb-6 flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          <Smartphone className="size-4 shrink-0 text-accent-strong" />O ClearChat é um app desktop
          — baixe no computador. Pelo celular você já pode usar o painel da conta.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-3 [&>*]:min-w-0">
        {cards.map((c, k) => (
          <SpotCard
            key={c.os}
            data-reveal
            style={{ transitionDelay: `${k * 70}ms` }}
            className={cx(
              'rounded-2xl border bg-surface/80 p-5 backdrop-blur',
              os === c.os
                ? 'border-accent/40 shadow-[0_0_0_1px_rgb(139_92_246/0.15),0_20px_60px_-30px_rgb(139_92_246/0.6)]'
                : 'border-border'
            )}
          >
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-[16px] font-semibold">
                <Laptop className="size-4 text-subtle" /> {c.title}
              </h3>
              {os === c.os && (
                <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-strong">
                  seu sistema
                </span>
              )}
            </div>
            <p className="mt-1 mb-4 text-[13px] text-subtle">{c.note}</p>
            <div className="space-y-2">
              {c.links.map((l) => (
                <AssetLink key={l.label} label={l.label} asset={l.asset} fallback={page} />
              ))}
            </div>
          </SpotCard>
        ))}
      </div>
      <p className="mt-6 text-center text-[13px] text-subtle">
        {release?.version ? (
          <>
            Versão <span className="font-mono text-muted">{release.version}</span>
            {release.publishedAt && <> · publicada em {formatDate(release.publishedAt)}</>} ·{' '}
          </>
        ) : null}
        <a href={page} rel="noopener" className="text-accent-strong hover:underline">
          Ver todas as versões e notas no GitHub
        </a>
      </p>
    </>
  )
}

/**
 * Âncoras internas ("#download"): com `<base href>` (caminho de base do self-host) o navegador as
 * resolveria contra a base — e perderia a query. Rolamos na própria página.
 */
function onAnchorClick(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest('a')
  const href = a?.getAttribute('href')
  if (!href || !href.startsWith('#') || e.defaultPrevented || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  const el = href === '#topo' ? document.body : document.getElementById(href.slice(1))
  if (href === '#topo') window.scrollTo({ top: 0, behavior: 'smooth' })
  else el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  history.replaceState(history.state, '', location.pathname + location.search + href)
}

export default function Landing() {
  const { info, phase } = useSession()
  const [release, setRelease] = useState<Release | null>(null)
  const [os] = useState<OS>(() => detectOS())
  const [shot, setShot] = useState(0)
  const [menu, setMenu] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLElement>(null)
  const amp = useRef(0)
  const downloadUrl = info?.links.download || DEFAULT_RELEASES
  const name = info?.name ?? 'ClearChat'
  const signupOpen = !!info?.features.signupOpen
  const loggedIn = phase === 'locked' || phase === 'unlocked' || phase === 'needs_setup'
  useReveal(rootRef)

  useEffect(() => {
    let alive = true
    void fetchLatestRelease(downloadUrl).then((r) => alive && setRelease(r))
    return () => {
      alive = false
    }
  }, [downloadUrl])

  // Chegando com âncora (ex.: "Baixar o app" do painel → /#download), rola até a seção.
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash])

  useEffect(() => {
    document.title =
      name === 'ClearChat'
        ? 'ClearChat — chat com IA, agentes, voz e controle total'
        : `${name} · ClearChat`
  }, [name])

  // cabeçalho transparente sobre o hero, vidro fosco depois de rolar
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])

  const nav = [
    { href: '#voz', label: 'Voz' },
    { href: '#recursos', label: 'Recursos' },
    { href: '#sync', label: 'Sincronização' },
    { href: '#download', label: 'Download' },
    { href: '#self-host', label: 'Self-host' }
  ]
  const authButtons = loggedIn ? (
    <Link to="/app">
      <Button variant="primary" size="sm">
        Abrir painel
      </Button>
    </Link>
  ) : (
    <>
      <Link to="/login">
        <Button variant="ghost" size="sm">
          Entrar
        </Button>
      </Link>
      {signupOpen && (
        <Link to="/signup">
          <Button variant="primary" size="sm">
            Criar conta
          </Button>
        </Link>
      )}
    </>
  )

  return (
    <div
      ref={rootRef}
      className="landing min-h-dvh overflow-x-clip"
      data-page-root
      onClick={onAnchorClick}
    >
      <CursorGlow />
      {/* ---------------- cabeçalho ---------------- */}
      <header
        className={cx(
          'sticky top-0 z-40 border-b transition-colors duration-300',
          scrolled || menu
            ? 'border-border/60 bg-bg/70 backdrop-blur-xl'
            : 'border-transparent bg-transparent'
        )}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <a href="#topo" className="rounded-lg" aria-label={name}>
            <Wordmark name={name} />
          </a>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Seções">
            {nav.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover/70 hover:text-fg"
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="hidden items-center gap-2 md:flex">
            <a
              href={REPO_URL}
              className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg"
              aria-label="GitHub"
              rel="noopener"
            >
              <GithubIcon className="size-4" />
            </a>
            {authButtons}
          </div>
          <button
            className="rounded-lg border border-border bg-bg/50 p-2 text-muted backdrop-blur md:hidden"
            onClick={() => setMenu((m) => !m)}
            aria-label="Menu"
            aria-expanded={menu}
          >
            {menu ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
        {menu && (
          <div className="animate-fade-in border-t border-border px-4 py-3 md:hidden">
            <nav className="grid gap-1" aria-label="Seções">
              {nav.map((n) => (
                <a
                  key={n.href}
                  href={n.href}
                  onClick={() => setMenu(false)}
                  className="rounded-lg px-3 py-2 text-[15px] text-muted hover:bg-hover hover:text-fg"
                >
                  {n.label}
                </a>
              ))}
              <a
                href={REPO_URL}
                rel="noopener"
                className="rounded-lg px-3 py-2 text-[15px] text-muted hover:bg-hover hover:text-fg"
              >
                GitHub
              </a>
            </nav>
            <div className="mt-3 flex gap-2 border-t border-border pt-3 [&>a]:flex-1 [&>a>button]:w-full">
              {authButtons}
            </div>
          </div>
        )}
      </header>

      {/* ---------------- hero ---------------- */}
      <section
        id="topo"
        ref={heroRef}
        className="relative isolate -mt-[57px] flex min-h-[100svh] items-center overflow-hidden px-4 pt-[400px] pb-16 sm:px-8 lg:pt-24 lg:pb-20"
      >
        <div aria-hidden className="hero-grid absolute inset-0 -z-20" />
        <Orb amp={amp} host={heroRef} className="absolute inset-0 -z-10 size-full" />
        <div aria-hidden className="hero-fade absolute inset-x-0 bottom-0 -z-10 h-40" />
        <div className="mx-auto grid w-full max-w-6xl items-end gap-10 lg:grid-cols-[1.08fr_1fr] lg:items-center [&>*]:min-w-0">
          <div className="text-center lg:text-left">
            <a
              href="#voz"
              className="hero-in group inline-flex items-center gap-2 rounded-full border border-accent/30 bg-bg/60 py-1 pr-3 pl-1 text-[12.5px] text-muted backdrop-blur hover:border-accent/60 hover:text-fg"
            >
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                Novo
              </span>
              Chamadas de voz com o seu agente
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </a>
            <h1 className="hero-in mt-6 text-[40px] leading-[1.02] font-semibold tracking-[-0.04em] text-balance [animation-delay:80ms] sm:text-[60px] lg:text-[64px]">
              O chat com IA que <span className="text-shimmer">mostra tudo</span> o que faz.
            </h1>
            <p className="hero-in mx-auto mt-6 max-w-xl text-[16px] leading-relaxed text-muted [animation-delay:160ms] sm:text-[18px] lg:mx-0">
              Agentes com ferramentas sob a sua aprovação, subagentes, memória, skills — e agora
              voz: ligue para o seu agente e interrompa quando quiser. Qualquer provedor, ou tudo
              local. Você vê cada byte que vai para a API.
            </p>
            <div className="hero-in mt-9 [animation-delay:240ms]">
              <DownloadCta os={os} release={release} downloadUrl={downloadUrl} />
            </div>
            <p className="hero-in mt-4 text-[12.5px] text-subtle [animation-delay:300ms]">
              {release?.version ? `Versão ${release.version} · ` : ''}grátis · código aberto · sem
              conta obrigatória
            </p>
          </div>
          <div className="hero-in flex flex-col items-center gap-4 [animation-delay:420ms] lg:items-end lg:self-end lg:pt-[44vh]">
            <CallTicker amp={amp} />
            <p className="hidden items-center gap-1.5 font-mono text-[11px] text-faint lg:flex">
              <MousePointer2 className="size-3" /> mova o mouse · clique na esfera
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- letreiro ---------------- */}
      <div className="border-y border-border/50 bg-surface/30 py-5 backdrop-blur">
        <Marquee items={STACK} className="font-mono text-[13px] text-subtle" />
      </div>

      {/* ---------------- voz ---------------- */}
      <Section
        id="voz"
        index="01"
        eyebrow="Voz"
        title={
          <>
            Ligue para o seu agente. <span className="text-muted">Ele atende.</span>
          </>
        }
        intro="Uma conversa de verdade, não um walkie-talkie: a transcrição começa enquanto você fala, a voz sai antes da resposta terminar e você pode interromper a qualquer momento — com as mesmas ferramentas e aprovações do chat."
      >
        <div className="grid items-start gap-8 lg:grid-cols-[1.05fr_1fr] [&>*]:min-w-0">
          <div data-reveal>
            <VoiceLab />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {VOICE.map((v, k) => (
              <SpotCard
                key={v.title}
                data-reveal
                style={{ transitionDelay: `${k * 60}ms` }}
                className="rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur"
              >
                <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
                  {v.icon}
                </div>
                <h3 className="mt-3 text-[14.5px] font-semibold">{v.title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{v.text}</p>
              </SpotCard>
            ))}
          </div>
        </div>
      </Section>

      {/* ---------------- recursos / aprovações ---------------- */}
      <Section
        id="recursos"
        index="02"
        eyebrow="Agente"
        title="Um agente de verdade, sem perder o controle."
        intro="Tudo o que o modelo faz passa por você: cada ferramenta tem uma política, e cada pedaço de um comando composto é julgado separadamente. Experimente — às vezes é você quem decide."
        className="section-glow"
      >
        <div className="grid items-stretch gap-8 lg:grid-cols-[1.15fr_1fr] [&>*]:min-w-0">
          <div data-reveal className="min-h-[420px]">
            <ApprovalDemo />
          </div>
          <ul className="flex flex-col justify-center gap-6">
            {[
              {
                icon: <ShieldCheck className="size-4" />,
                title: 'Uma política por ferramenta',
                text: 'Comandos, processos, páginas, busca, escrita de arquivos, delegação: sempre permitir, perguntar, listas ou Smart-Approve.'
              },
              {
                icon: <Sparkles className="size-4" />,
                title: 'Smart-Approve',
                text: 'Um modelo juiz lê o contexto e libera o que é seguro. Na dúvida, ele pergunta para você.'
              },
              {
                icon: <Terminal className="size-4" />,
                title: 'Cada sub-comando conta',
                text: 'Em `a && b | c`, whitelist e blacklist valem para cada parte — um `| sh` escondido não passa.'
              }
            ].map((p, k) => (
              <li
                key={p.title}
                data-reveal
                style={{ transitionDelay: `${k * 80}ms` }}
                className="flex gap-4"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-accent-strong">
                  {p.icon}
                </div>
                <div>
                  <h3 className="text-[15.5px] font-semibold">{p.title}</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-muted">{withCode(p.text)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-20 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, k) => (
            <SpotCard
              key={f.title}
              data-reveal
              style={{ transitionDelay: `${(k % 4) * 60}ms` }}
              className={cx(
                'rounded-2xl border border-border bg-surface/70 p-5 backdrop-blur sm:p-6',
                f.wide && 'lg:col-span-2'
              )}
            >
              <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
                {f.icon}
              </div>
              <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{f.text}</p>
            </SpotCard>
          ))}
        </div>
      </Section>

      {/* ---------------- transparência ---------------- */}
      <Section
        id="transparencia"
        index="03"
        eyebrow="Transparência"
        title={
          <>
            Nada de caixa-preta. <span className="text-muted">Veja o body exato.</span>
          </>
        }
        intro="Passe o mouse em cada pedaço do chat e veja no que ele vira na request — persona, memória, ferramentas, parâmetros. Custo, tokens e cache em cada resposta."
      >
        <div data-reveal>
          <RequestInspector />
        </div>
      </Section>

      {/* ---------------- galeria ---------------- */}
      <Section
        id="galeria"
        index="04"
        eyebrow="Por dentro"
        title="Minimalista por fora. Completo por dentro."
        className="section-glow"
      >
        <div className="grid items-start gap-8 lg:grid-cols-[17rem_1fr] [&>*]:min-w-0">
          <div
            className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
            role="tablist"
            aria-label="Capturas de tela"
          >
            {SHOTS.map((s, i) => [
              (i === 0 || SHOTS[i - 1].group !== s.group) && (
                <span
                  key={`g${s.group}`}
                  className={cx(
                    'hidden font-mono text-[11px] tracking-[0.16em] text-faint uppercase lg:block',
                    i > 0 && 'mt-3'
                  )}
                >
                  {s.group}
                </span>
              ),
              <button
                key={s.title}
                role="tab"
                aria-selected={shot === i}
                onClick={() => setShot(i)}
                className={cx(
                  'relative shrink-0 rounded-xl border px-4 py-2.5 text-left transition-all lg:shrink',
                  shot === i
                    ? 'border-accent/40 bg-accent-soft shadow-[0_0_30px_-12px_rgb(139_92_246/0.8)]'
                    : 'border-border bg-surface/70 hover:bg-hover'
                )}
              >
                <span className="block text-sm font-medium whitespace-nowrap lg:whitespace-normal">
                  {s.title}
                </span>
                <span className="mt-0.5 hidden text-[12.5px] leading-relaxed text-subtle lg:block">
                  {withCode(s.text)}
                </span>
              </button>
            ])}
          </div>
          <div data-reveal>
            <Tilt>
              <WindowFrame
                key={shot}
                className="animate-fade-in"
                src={SHOTS[shot].src}
                alt={`${SHOTS[shot].title}: ${SHOTS[shot].text}`}
              />
            </Tilt>
            <p className="mt-3 text-center text-[13px] text-subtle lg:hidden">{SHOTS[shot].text}</p>
          </div>
        </div>
      </Section>

      {/* ---------------- sync ---------------- */}
      <Section
        id="sync"
        index="05"
        eyebrow="Sincronização"
        title="Seus chats em todos os dispositivos. Legíveis só para você."
        intro={`Com uma conta em ${name}, conversas, provedores, personas e memórias sincronizam entre os seus computadores — cifrados ponta a ponta antes de sair de cada um. Digite abaixo: a cifragem é real, feita agora no seu navegador.`}
      >
        <div data-reveal>
          <CryptoPlayground />
        </div>
        <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: <KeyRound className="size-4" />,
              title: 'A senha nunca sai do dispositivo',
              text: 'Ela deriva a chave (Argon2id) que abre os seus dados. O servidor guarda só envelopes AES-256-GCM.'
            },
            {
              icon: <ShieldCheck className="size-4" />,
              title: 'Chave de recuperação',
              text: 'Gerada no seu navegador e mostrada uma única vez. Sem ela e sem a senha, ninguém lê nada.'
            },
            {
              icon: <Terminal className="size-4" />,
              title: 'O chat roda onde as ferramentas estão',
              text: 'Cada conversa executa num dispositivo; os outros assistem ao vivo e enviam comandos.'
            },
            {
              icon: <Zap className="size-4" />,
              title: 'Login sem senha',
              text: 'Entrar é por código no e-mail; desbloquear é com a sua senha. Desconecte dispositivos quando quiser.'
            }
          ].map((p, k) => (
            <li key={p.title} data-reveal style={{ transitionDelay: `${k * 70}ms` }}>
              <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-elevated text-accent-strong">
                {p.icon}
              </div>
              <h3 className="mt-3 text-[15px] font-semibold">{p.title}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{p.text}</p>
            </li>
          ))}
        </ul>
        {!loggedIn && (
          <div className="mt-10 flex flex-col justify-center gap-2 sm:flex-row" data-reveal>
            {signupOpen && (
              <Link to="/signup">
                <Button variant="primary" className="w-full sm:w-auto">
                  Criar conta grátis
                </Button>
              </Link>
            )}
            <Link to="/login">
              <Button className="w-full sm:w-auto">Entrar</Button>
            </Link>
          </div>
        )}
      </Section>

      {/* ---------------- download ---------------- */}
      <Section
        id="download"
        index="06"
        eyebrow="Download"
        title="Baixe o ClearChat."
        intro="Funciona sozinho, sem conta. A sincronização é opcional e pode ser ligada depois nas configurações."
        className="section-glow"
      >
        <Downloads release={release} downloadUrl={downloadUrl} os={os} />
      </Section>

      {/* ---------------- self-host ---------------- */}
      <Section
        id="self-host"
        index="07"
        eyebrow="Self-host"
        title="Prefere o seu próprio servidor?"
        intro="O servidor de sync é código aberto e roda em qualquer máquina com Docker — inclusive na sua rede local, com ou sem domínio. No app: Configurações → Conta → Servidor → Self-host."
      >
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] [&>*]:min-w-0">
          <div data-reveal className="glass overflow-hidden rounded-2xl">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
              <span className="font-mono text-[12px] text-subtle">terminal</span>
              <CopyButton
                text={`git clone ${SERVER_REPO_URL}.git && cd ClearChatWebsite\ncp .env.example .env   # PUBLIC_BASE_URL, segredos, SMTP\ndocker compose --profile edge up -d --build`}
                variant="ghost"
              />
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-muted">
              <span className="text-accent-strong">$ </span>git clone {SERVER_REPO_URL}.git{'\n'}
              <span className="text-accent-strong">$ </span>cd ClearChatWebsite && cp .env.example
              .env
              {'\n'}
              <span className="text-faint">
                # PUBLIC_BASE_URL, segredos, SMTP (captcha é opcional)
              </span>
              {'\n'}
              <span className="text-accent-strong">$ </span>docker compose --profile edge up -d
              --build
              <span className="caret" aria-hidden />
            </pre>
          </div>
          <ul className="space-y-3 text-[14px] text-muted">
            {[
              'Zero-knowledge também no seu servidor: ele nunca vê senhas nem conteúdo.',
              'Postgres + API FastAPI + este site, com painel admin só em 127.0.0.1.',
              'Cadastro fechado com convites, cotas por usuário e captcha opcional.',
              'Funciona em sub-caminho (ex.: https://exemplo.com/clearchat).'
            ].map((t, k) => (
              <li
                key={t}
                className="flex gap-3"
                data-reveal
                style={{ transitionDelay: `${k * 60}ms` }}
              >
                <Check className="mt-0.5 size-4 shrink-0 text-success" />
                {t}
              </li>
            ))}
            <li className="pt-2" data-reveal>
              <a
                href={SERVER_REPO_URL}
                rel="noopener"
                className="inline-flex items-center gap-1.5 text-accent-strong hover:underline"
              >
                Guia de self-host no GitHub <ArrowRight className="size-3.5" />
              </a>
            </li>
          </ul>
        </div>
      </Section>

      {/* ---------------- chamada final ---------------- */}
      <section className="relative isolate overflow-hidden px-4 py-28 text-center sm:px-8 sm:py-36">
        <div aria-hidden className="final-glow absolute inset-0 -z-10" />
        <p
          data-reveal
          className="font-mono text-[12px] tracking-[0.18em] text-accent-strong uppercase"
        >
          Código aberto · Windows, macOS e Linux
        </p>
        <h2
          data-reveal
          className="mx-auto mt-5 max-w-3xl text-[36px] leading-[1.04] font-semibold tracking-[-0.04em] text-balance sm:text-[60px]"
        >
          A IA trabalha. <span className="text-shimmer">Você vê tudo.</span>
        </h2>
        <div data-reveal className="mt-10">
          <DownloadCta os={os} release={release} downloadUrl={downloadUrl} center />
        </div>
      </section>

      {/* ---------------- rodapé ---------------- */}
      <footer className="border-t border-border px-4 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 text-[13px] text-subtle sm:flex-row">
          <div className="flex items-center gap-2.5">
            <AppIcon className="size-6" />
            <span>
              {name}
              {name !== 'ClearChat' && ' · uma instância do ClearChat'}
            </span>
          </div>
          <nav className="flex flex-wrap justify-center gap-x-5 gap-y-2" aria-label="Rodapé">
            <a href={REPO_URL} rel="noopener" className="hover:text-fg">
              GitHub
            </a>
            <a href={downloadUrl} rel="noopener" className="hover:text-fg">
              Releases
            </a>
            <a href={SERVER_REPO_URL} rel="noopener" className="hover:text-fg">
              Servidor
            </a>
            <Link to="/login" className="hover:text-fg">
              Entrar
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
