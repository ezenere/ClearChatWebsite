// Página inicial (só com `features.landing`): apresenta o ClearChat, downloads e self-host.
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  ArrowRight,
  Bot,
  Boxes,
  Brain,
  Check,
  Download,
  Eye,
  HandMetal,
  KeyRound,
  Laptop,
  LockKeyhole,
  Menu,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  X
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
import shotChat from '../assets/screenshots/chat.webp'
import shotQueue from '../assets/screenshots/aprovacoes-fila.webp'
import shotAsk from '../assets/screenshots/questionario.webp'
import shotLists from '../assets/screenshots/configuracoes-aprovacoes.webp'
import shotMemory from '../assets/screenshots/memoria.webp'
import shotMarkdown from '../assets/screenshots/markdown.webp'

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

const REPO_URL = 'https://github.com/ezenere/ClearChat'
const SERVER_REPO_URL = 'https://github.com/ezenere/ClearChatWebsite'

const FEATURES: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <Sparkles className="size-5" />,
    title: 'Qualquer provedor',
    text: 'OpenAI-compatible, OpenRouter e Anthropic nativa. Parâmetros que o modelo não aceita somem do painel e não vão na request.'
  },
  {
    icon: <HandMetal className="size-5" />,
    title: 'Ferramentas com aprovação',
    text: 'Shell, arquivos, processos, navegador e busca na web. Você decide por item: sempre, Smart-Approve, listas ou perguntar.'
  },
  {
    icon: <Bot className="size-5" />,
    title: 'Subagentes',
    text: 'Em paralelo, com modelo próprio e em segundo plano — acordam o agente principal ao terminar.'
  },
  {
    icon: <Brain className="size-5" />,
    title: 'Memória modular',
    text: 'Coleções por categoria (perfil, tópicos, pessoas…), ativadas por chat ou persona, editáveis a qualquer momento.'
  },
  {
    icon: <Boxes className="size-5" />,
    title: 'Skills',
    text: 'Formato Agent Skills (pasta com SKILL.md): o modelo descobre e carrega sob demanda, sem inflar o contexto.'
  },
  {
    icon: <Eye className="size-5" />,
    title: 'Transparência total',
    text: '"Ver request" mostra o body exato enviado. Custo, tokens e cache em cada resposta.'
  },
  {
    icon: <LockKeyhole className="size-5" />,
    title: 'Sync ponta a ponta',
    text: 'Conversas, provedores e memórias sincronizados entre dispositivos — cifrados antes de sair deles.'
  },
  {
    icon: <Server className="size-5" />,
    title: 'Self-host',
    text: 'Rode o seu servidor de sync com Docker Compose. O app conecta em qualquer instância.'
  }
]

const SHOTS = [
  {
    src: shotQueue,
    title: 'Fila de aprovações',
    text: 'Vários subagentes pedindo ao mesmo tempo: "1 de 3", um de cada vez.'
  },
  {
    src: shotAsk,
    title: 'Questionário do agente',
    text: 'O agente pergunta com opções, ícones e imagens — sempre há "Outro".'
  },
  {
    src: shotLists,
    title: 'Whitelist e blacklist',
    text: 'Teste um comando e veja o veredito de cada sub-comando de `a && b | c`.'
  },
  {
    src: shotMemory,
    title: 'Memória',
    text: 'Ferramentas de busca e gravação no chat e o painel de coleções.'
  },
  {
    src: shotMarkdown,
    title: 'Markdown de verdade',
    text: 'LaTeX, blocos de código aninhados e streaming.'
  }
]

function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
  className
}: {
  id?: string
  eyebrow: string
  title: ReactNode
  intro?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={cx('scroll-mt-20 px-4 py-16 sm:px-8 sm:py-24', className)}>
      <div className="mx-auto max-w-6xl">
        <p className="text-[13px] font-medium tracking-wide text-accent-strong uppercase">
          {eyebrow}
        </p>
        <h2 className="mt-2 max-w-3xl text-[26px] leading-tight font-semibold tracking-tight sm:text-[34px]">
          {title}
        </h2>
        {intro && (
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted sm:text-base">
            {intro}
          </p>
        )}
        <div className="mt-10 sm:mt-12">{children}</div>
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
  downloadUrl
}: {
  os: OS
  release: Release | null
  downloadUrl: string
}) {
  const desktop = os === 'windows' || os === 'mac' || os === 'linux'
  const asset = primaryAsset(os, release)
  const href = asset?.url ?? release?.pageUrl ?? downloadUrl
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
      <a
        href={desktop ? href : '#download'}
        className="w-full sm:w-auto"
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
        <Button size="lg" variant="secondary" className="w-full sm:w-auto">
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
      <Download className="size-4 shrink-0 text-subtle group-hover:text-accent-strong" />
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
        {cards.map((c) => (
          <div
            key={c.os}
            className={cx(
              'rounded-2xl border bg-surface p-5',
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
          </div>
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
  const downloadUrl = info?.links.download || DEFAULT_RELEASES
  const name = info?.name ?? 'ClearChat'
  const signupOpen = !!info?.features.signupOpen
  const loggedIn = phase === 'locked' || phase === 'unlocked' || phase === 'needs_setup'

  useEffect(() => {
    let alive = true
    void fetchLatestRelease(downloadUrl).then((r) => alive && setRelease(r))
    return () => {
      alive = false
    }
  }, [downloadUrl])

  useEffect(() => {
    document.title =
      name === 'ClearChat'
        ? 'ClearChat — chat com IA, agentes e controle total'
        : `${name} · ClearChat`
  }, [name])

  const nav = [
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
    <div className="min-h-dvh overflow-x-hidden" data-page-root onClick={onAnchorClick}>
      {/* ---------------- cabeçalho ---------------- */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <a href="#topo" className="rounded-lg" aria-label={name}>
            <Wordmark name={name} />
          </a>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Seções">
            {nav.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
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
            className="rounded-lg border border-border p-2 text-muted md:hidden"
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
      <section id="topo" className="glow relative px-4 pt-14 pb-16 sm:px-8 sm:pt-20 sm:pb-24">
        <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1fr_1.15fr] [&>*]:min-w-0">
          <div className="text-center lg:text-left">
            <a
              href={REPO_URL}
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1 text-[12.5px] text-muted hover:text-fg"
            >
              <span className="size-1.5 rounded-full bg-success" /> Código aberto · Windows, macOS e
              Linux
            </a>
            <h1 className="mt-6 text-[36px] text-balance leading-[1.08] font-semibold tracking-[-0.025em] sm:text-[52px]">
              O chat com IA que{' '}
              <span className="bg-gradient-to-r from-[#c4b5fd] via-accent-strong to-[#7c5cf0] bg-clip-text text-transparent">
                mostra tudo
              </span>{' '}
              o que faz.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-muted sm:text-[17px] lg:mx-0">
              ClearChat é um app desktop minimalista para conversar com qualquer modelo — com
              agentes, ferramentas sob a sua aprovação, subagentes, memória e skills. Você vê
              exatamente o que vai para a API.
            </p>
            <div className="mt-8">
              <DownloadCta os={os} release={release} downloadUrl={downloadUrl} />
            </div>
            <p className="mt-4 text-[12.5px] text-subtle">
              {release?.version ? `Versão ${release.version} · ` : ''}grátis · sem conta obrigatória
            </p>
          </div>
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-8 -z-10 rounded-[40px] bg-accent/10 blur-3xl"
            />
            <WindowFrame
              src={shotChat}
              alt="Chat com agente: ferramenta de shell aguardando aprovação comando a comando"
              eager
            />
          </div>
        </div>
      </section>

      {/* ---------------- recursos ---------------- */}
      <Section
        id="recursos"
        eyebrow="Recursos"
        title="Um agente de verdade, sem perder o controle."
        intro="Tudo o que o modelo faz passa por você: cada ferramenta tem uma política, cada request pode ser inspecionada, e nada sai do seu computador sem você saber."
      >
        <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-surface p-5 sm:p-6">
              <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
                {f.icon}
              </div>
              <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{f.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-14 grid items-start gap-8 lg:grid-cols-[18rem_1fr] [&>*]:min-w-0">
          <div
            className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible"
            role="tablist"
            aria-label="Capturas de tela"
          >
            {SHOTS.map((s, i) => (
              <button
                key={s.title}
                role="tab"
                aria-selected={shot === i}
                onClick={() => setShot(i)}
                className={cx(
                  'shrink-0 rounded-xl border px-4 py-3 text-left transition-colors lg:shrink',
                  shot === i
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-border bg-surface hover:bg-hover'
                )}
              >
                <span className="block text-sm font-medium whitespace-nowrap lg:whitespace-normal">
                  {s.title}
                </span>
                <span className="mt-0.5 hidden text-[12.5px] leading-relaxed text-subtle lg:block">
                  {s.text}
                </span>
              </button>
            ))}
          </div>
          <div>
            <WindowFrame src={SHOTS[shot].src} alt={`${SHOTS[shot].title}: ${SHOTS[shot].text}`} />
            <p className="mt-3 text-center text-[13px] text-subtle lg:hidden">{SHOTS[shot].text}</p>
          </div>
        </div>
      </Section>

      {/* ---------------- sync ---------------- */}
      <Section
        id="sync"
        eyebrow="Sincronização"
        title="Seus chats em todos os dispositivos. Legíveis só para você."
        intro={`Com uma conta em ${name}, conversas, provedores, personas e memórias sincronizam entre os seus computadores — cifrados ponta a ponta antes de sair de cada um.`}
        className="border-y border-border/60 bg-surface/30"
      >
        <div className="grid gap-10 lg:grid-cols-2 [&>*]:min-w-0">
          <ul className="space-y-5">
            {[
              {
                icon: <KeyRound className="size-4" />,
                title: 'A senha nunca sai do dispositivo',
                text: 'Ela deriva a chave (Argon2id) que abre os seus dados. O servidor guarda só envelopes cifrados com AES-256-GCM.'
              },
              {
                icon: <ShieldCheck className="size-4" />,
                title: 'Chave de recuperação',
                text: 'Gerada no seu navegador no cadastro e mostrada uma única vez. Sem ela e sem a senha, nem o servidor consegue ler nada.'
              },
              {
                icon: <Terminal className="size-4" />,
                title: 'O chat roda onde as ferramentas estão',
                text: 'Cada conversa executa num dispositivo (o host, onde o shell e os arquivos agem). Os outros assistem ao vivo e enviam comandos.'
              },
              {
                icon: <Laptop className="size-4" />,
                title: 'Login sem senha',
                text: 'Entrar é por código no e-mail; desbloquear os dados é com a sua senha. Cada dispositivo pode ser desconectado a qualquer momento.'
              }
            ].map((p) => (
              <li key={p.title} className="flex gap-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-accent-strong">
                  {p.icon}
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold">{p.title}</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-muted">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="rounded-2xl border border-border bg-bg/60 p-5 sm:p-7">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center text-[12.5px]">
              <div className="rounded-xl border border-border bg-surface px-2 py-4">
                <Laptop className="mx-auto mb-2 size-5 text-muted" />
                PC de casa
                <p className="mt-1 font-mono text-[11px] text-success">texto claro</p>
              </div>
              <ArrowRight className="size-4 text-subtle" />
              <div className="rounded-xl border border-accent/30 bg-accent-soft px-2 py-4">
                <Server className="mx-auto mb-2 size-5 text-accent-strong" />
                Servidor
                <p className="mt-1 font-mono text-[11px] text-accent-strong">só cifrado</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center text-[12.5px]">
              <div />
              <ArrowRight className="size-4 rotate-90 text-subtle sm:rotate-[135deg]" />
              <div className="rounded-xl border border-border bg-surface px-2 py-4">
                <Laptop className="mx-auto mb-2 size-5 text-muted" />
                Notebook
                <p className="mt-1 font-mono text-[11px] text-success">texto claro</p>
              </div>
            </div>
            <pre className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface p-4 font-mono text-[11.5px] leading-relaxed text-subtle">
              {`{ "type": "message", "rev": 3,
  "env": { "v": 1, "k": 1,
    "n": "VVVVVVVVVVVVVVVV",
    "c": "A3VSbzes1Tl0k9GpgM6G8lHRbAnRp…" } }`}
            </pre>
            <p className="mt-2 text-center text-[12px] text-faint">
              o que o servidor guarda de uma mensagem
            </p>
            {!loggedIn && (
              <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                {signupOpen && (
                  <Link to="/signup" className="flex-1">
                    <Button variant="primary" className="w-full">
                      Criar conta grátis
                    </Button>
                  </Link>
                )}
                <Link to="/login" className="flex-1">
                  <Button className="w-full">Entrar</Button>
                </Link>
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* ---------------- download ---------------- */}
      <Section
        id="download"
        eyebrow="Download"
        title="Baixe o ClearChat."
        intro="Funciona sozinho, sem conta. A sincronização é opcional e pode ser ligada depois nas configurações."
      >
        <Downloads release={release} downloadUrl={downloadUrl} os={os} />
      </Section>

      {/* ---------------- self-host ---------------- */}
      <Section
        id="self-host"
        eyebrow="Self-host"
        title="Prefere o seu próprio servidor?"
        intro="O servidor de sync é código aberto e roda em qualquer máquina com Docker — inclusive na sua rede local, com ou sem domínio. No app: Configurações → Conta → Servidor → Self-host."
        className="border-t border-border/60 bg-surface/30"
      >
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] [&>*]:min-w-0">
          <div className="overflow-hidden rounded-2xl border border-border bg-bg">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="font-mono text-[12px] text-subtle">terminal</span>
              <CopyButton
                text={`git clone ${SERVER_REPO_URL}.git && cd ClearChatWebsite\ncp .env.example .env   # PUBLIC_BASE_URL, segredos, SMTP\ndocker compose --profile edge up -d --build`}
                variant="ghost"
              />
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-muted">
              <span className="text-subtle">$ </span>git clone {SERVER_REPO_URL}.git{'\n'}
              <span className="text-subtle">$ </span>cd ClearChatWebsite && cp .env.example .env
              {'\n'}
              <span className="text-faint">
                # PUBLIC_BASE_URL, segredos, SMTP (captcha é opcional)
              </span>
              {'\n'}
              <span className="text-subtle">$ </span>docker compose --profile edge up -d --build
            </pre>
          </div>
          <ul className="space-y-3 text-[14px] text-muted">
            {[
              'Zero-knowledge também no seu servidor: ele nunca vê senhas nem conteúdo.',
              'Postgres + API FastAPI + este site, com painel admin só em 127.0.0.1.',
              'Cadastro fechado com convites, cotas por usuário e captcha opcional.',
              'Funciona em sub-caminho (ex.: https://exemplo.com/clearchat).'
            ].map((t) => (
              <li key={t} className="flex gap-3">
                <Check className="mt-0.5 size-4 shrink-0 text-success" />
                {t}
              </li>
            ))}
            <li className="pt-2">
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
