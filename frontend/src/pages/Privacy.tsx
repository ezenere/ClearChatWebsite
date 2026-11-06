// Política de privacidade pública (pt-BR) da instância oficial (clear.ezenere.com) e do app Android.
// Também é a URL de "excluir conta" da Google Play: /privacidade#excluir-conta.
import { useEffect, type MouseEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, Mail, ShieldCheck, Trash2 } from 'lucide-react'
import { Wordmark } from '../components/Logo'
import { cx } from '../components/ui'
import { contactEmail } from '../api/config'

const UPDATED = '6 de novembro de 2026'
const SITE = 'https://clear.ezenere.com'
const PAGE_TITLE = 'Política de Privacidade · ClearChat'

const SECTIONS = [
  { id: 'resumo', title: 'Resumo' },
  { id: 'controlador', title: 'Quem é o controlador' },
  { id: 'dados', title: 'Quais dados tratamos' },
  { id: 'criptografia', title: 'Criptografia de ponta a ponta' },
  { id: 'provedores-ia', title: 'Provedores de IA e de voz' },
  { id: 'terceiros', title: 'Serviços de terceiros' },
  { id: 'android', title: 'Permissões do app Android' },
  { id: 'finalidades', title: 'Finalidades e bases legais' },
  { id: 'nao-fazemos', title: 'O que não fazemos' },
  { id: 'retencao', title: 'Por quanto tempo guardamos' },
  { id: 'excluir-conta', title: 'Como excluir sua conta' },
  { id: 'direitos', title: 'Seus direitos (LGPD)' },
  { id: 'menores', title: 'Crianças e adolescentes' },
  { id: 'auto-hospedagem', title: 'Instâncias auto-hospedadas' },
  { id: 'alteracoes', title: 'Alterações nesta política' },
  { id: 'contato', title: 'Contato' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === id)?.title
  return (
    <section
      id={id}
      className="scroll-mt-6 border-t border-border pt-8 first:border-t-0 first:pt-0"
    >
      <h2 className="text-lg font-semibold tracking-tight text-fg sm:text-xl">
        <a href={`#${id}`} className="rounded hover:text-accent-strong">
          {title}
        </a>
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  )
}

function List({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ul className={cx('list-disc space-y-1.5 pl-5 marker:text-subtle', className)}>{children}</ul>
  )
}

function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-fg">{children}</strong>
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      className="text-accent-strong underline decoration-accent/40 underline-offset-2 hover:decoration-accent-strong"
    >
      {children}
    </a>
  )
}

/** E-mail de contato (PRIVACY_CONTACT_EMAIL do container); sem ele, aponta para o operador. */
function ContactLink() {
  const email = contactEmail()
  if (!email) return <>o e-mail de contato do operador desta instância</>
  return (
    <a
      href={`mailto:${email}`}
      className="font-medium break-all text-accent-strong underline decoration-accent/40 underline-offset-2 hover:decoration-accent-strong"
    >
      {email}
    </a>
  )
}

function Toc({ className }: { className?: string }) {
  return (
    <ol className={cx('space-y-0.5 text-[13px]', className)}>
      {SECTIONS.map((s, i) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            className="flex gap-2 rounded-md px-2 py-1 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <span className="w-5 shrink-0 text-right font-mono text-subtle tabular-nums">
              {i + 1}.
            </span>
            <span>{s.title}</span>
          </a>
        </li>
      ))}
    </ol>
  )
}

/**
 * Âncoras internas ("#excluir-conta"): com `<base href>` o navegador as resolveria contra a base
 * (iria para a página inicial). Rolamos na própria página, como na landing.
 */
function onAnchorClick(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest('a')
  const href = a?.getAttribute('href')
  if (!href || !href.startsWith('#') || e.defaultPrevented || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  history.replaceState(history.state, '', location.pathname + location.search + href)
}

export default function Privacy() {
  const { hash } = useLocation()

  useEffect(() => {
    const prev = document.title
    document.title = PAGE_TITLE
    return () => {
      document.title = prev
    }
  }, [])

  // O roteador não rola até a âncora sozinho (ex.: link da Play Store para #excluir-conta).
  useEffect(() => {
    if (!hash) return
    let id = hash.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      // âncora malformada: usa como veio
    }
    const el = document.getElementById(id)
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }))
  }, [hash])

  return (
    <div className="glow min-h-dvh" data-page-root onClick={onAnchorClick}>
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-8 sm:py-6">
        <Link to="/" className="rounded-lg" aria-label="Início">
          <Wordmark />
        </Link>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft className="size-4" />
          <span>Início</span>
        </Link>
      </header>

      <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-8 lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:block">
          <nav aria-label="Índice" className="sticky top-6 pt-1">
            <p className="mb-2 px-2 text-xs font-medium tracking-wide text-subtle uppercase">
              Nesta página
            </p>
            <Toc />
          </nav>
        </aside>

        <main className="min-w-0 max-w-3xl">
          <div className="mb-8">
            <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent-soft px-3 py-1 text-xs font-medium text-accent-strong">
              <ShieldCheck className="size-3.5" />
              Privacidade
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              Política de Privacidade do ClearChat
            </h1>
            <p className="mt-2 text-sm text-subtle">Última atualização: {UPDATED}</p>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              Esta política explica quais dados pessoais são tratados quando você usa a instância
              oficial do ClearChat em <Ext href={SITE}>clear.ezenere.com</Ext> e os aplicativos do
              ClearChat conectados a ela, incluindo o app Android (
              <code className="font-mono text-[13px] text-fg">com.ezenere.clearchat</code>
              ). Ela segue a Lei Geral de Proteção de Dados (Lei nº 13.709/2018, LGPD).
            </p>
          </div>

          <details className="mb-8 rounded-2xl border border-border bg-surface lg:hidden">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-fg select-none">
              Índice
            </summary>
            <nav aria-label="Índice" className="border-t border-border px-2 py-2">
              <Toc />
            </nav>
          </details>

          <div className="space-y-8">
            <Section id="resumo">
              <List>
                <li>
                  Suas conversas, mensagens, anexos, chaves de API, memórias e configurações são{' '}
                  <B>criptografadas no seu dispositivo</B>. O servidor guarda só dados cifrados e{' '}
                  <B>não consegue lê-los</B>.
                </li>
                <li>
                  Em claro, o servidor conhece apenas o necessário para funcionar: seu e-mail, seu
                  nome, seus dispositivos e metadados técnicos dos registros.
                </li>
                <li>
                  O conteúdo das conversas vai <B>direto do seu dispositivo</B> para os provedores
                  de IA que você mesmo configura, com as suas chaves — não passa pelo nosso
                  servidor.
                </li>
                <li>
                  Não há anúncios, não há SDKs de análise ou rastreamento e não vendemos nem
                  compartilhamos dados para marketing.
                </li>
                <li>
                  Você pode{' '}
                  <a
                    href="#excluir-conta"
                    className="text-accent-strong underline decoration-accent/40 underline-offset-2"
                  >
                    apagar sua conta
                  </a>{' '}
                  a qualquer momento; os dados saem do servidor na hora.
                </li>
              </List>
            </Section>

            <Section id="controlador">
              <p>
                O controlador dos dados pessoais é{' '}
                <B>o mantenedor da instância oficial do ClearChat (clear.ezenere.com)</B>. Para
                qualquer assunto de privacidade, inclusive para falar com o encarregado, escreva
                para <ContactLink />.
              </p>
            </Section>

            <Section id="dados">
              <h3 className="font-medium text-fg">Dados da conta</h3>
              <List>
                <li>
                  <B>E-mail e nome</B>, informados no cadastro.
                </li>
                <li>
                  O login é feito por um <B>código de 6 dígitos enviado por e-mail</B> (via servidor
                  SMTP). Os códigos são apagados depois que expiram.
                </li>
              </List>

              <h3 className="pt-2 font-medium text-fg">Dados criptografados de ponta a ponta</h3>
              <p>
                Conversas, mensagens, títulos, configurações, chaves de API de provedores, memórias,
                anexos e skills. Ficam no servidor apenas como texto cifrado, que só os seus
                dispositivos conseguem abrir (veja{' '}
                <a
                  href="#criptografia"
                  className="text-accent-strong underline decoration-accent/40 underline-offset-2"
                >
                  Criptografia de ponta a ponta
                </a>
                ).
              </p>

              <h3 className="pt-2 font-medium text-fg">Dados que o servidor vê em claro</h3>
              <List>
                <li>Seu e-mail e seu nome.</li>
                <li>
                  Seus <B>dispositivos</B>: nome, plataforma, tipo de cliente, versão do app,
                  endereço IP e último acesso.
                </li>
                <li>
                  <B>Metadados dos registros</B>: tipos, identificadores aleatórios, tamanhos e
                  datas/horários.
                </li>
                <li>Qual dispositivo executa cada conversa.</li>
                <li>Os tipos dos comandos remotos enviados entre seus dispositivos.</li>
                <li>
                  Para notificações push: o token push do dispositivo, o tipo da notificação, uma
                  etiqueta aleatória, os destinatários e o horário. O <B>conteúdo</B> das
                  notificações é criptografado de ponta a ponta.
                </li>
                <li>
                  <B>Registro de atividade de segurança</B>: entradas, saídas e revogação de
                  dispositivos, com o endereço IP.
                </li>
              </List>

              <h3 className="pt-2 font-medium text-fg">Cookies</h3>
              <p>
                O site usa apenas um cookie essencial de sessão, necessário para manter você
                conectado. Não usamos cookies de publicidade nem de rastreamento.
              </p>
            </Section>

            <Section id="criptografia">
              <p>
                O conteúdo da sua conta é cifrado <B>no seu dispositivo</B> com uma chave derivada
                da sua senha (Argon2id) antes de ser enviado. O servidor armazena e sincroniza só o
                texto cifrado e <B>não tem como ler</B> conversas, mensagens, títulos,
                configurações, chaves de API, memórias, anexos ou skills.
              </p>
              <div className="rounded-xl border border-warning/30 bg-warning/[0.07] px-4 py-3 text-fg">
                Por isso, <B>se você perder a senha e também a chave de recuperação</B>, ninguém —
                nem nós — consegue recuperar esses dados. Guarde a chave de recuperação em local
                seguro.
              </div>
            </Section>

            <Section id="provedores-ia">
              <p>
                Os apps do ClearChat enviam o conteúdo das conversas{' '}
                <B>diretamente do seu dispositivo</B> para os provedores de IA e de voz que você
                configura com as suas próprias chaves de API — por exemplo OpenAI, OpenRouter,
                ElevenLabs ou endpoints locais. Esse tráfego <B>não passa pelo nosso servidor</B>.
              </p>
              <p>
                O tratamento feito por esses provedores segue as políticas de privacidade e os
                termos de cada um, que você aceita diretamente com eles. Escolha provedores em que
                você confia.
              </p>
            </Section>

            <Section id="terceiros">
              <List>
                <li>
                  <B>Cloudflare Turnstile</B>: ao pedir um código de acesso ou criar conta, pode ser
                  exibida uma verificação anti-robô. Ela é processada pela Cloudflare, conforme a{' '}
                  <Ext href="https://www.cloudflare.com/privacypolicy/">
                    política de privacidade da Cloudflare
                  </Ext>
                  .
                </li>
                <li>
                  <B>Google Firebase Cloud Messaging</B> (app Android): usado para entregar
                  notificações push. O Google recebe o token push do dispositivo e a mensagem já
                  criptografada, conforme a{' '}
                  <Ext href="https://policies.google.com/privacy">
                    política de privacidade do Google
                  </Ext>
                  .
                </li>
                <li>
                  <B>Envio de e-mail</B>: os códigos de acesso são enviados para o seu endereço por
                  um servidor de e-mail (SMTP).
                </li>
                <li>
                  <B>Provedores de IA e de voz</B> escolhidos por você (veja a seção anterior).
                </li>
              </List>
              <p>
                Alguns desses serviços podem processar dados fora do Brasil, sob as garantias
                previstas nas respectivas políticas.
              </p>
            </Section>

            <Section id="android">
              <p>
                O app Android pede apenas as permissões abaixo, cada uma para um uso específico:
              </p>
              <List>
                <li>
                  <B>Microfone</B>: usado somente quando você toca no botão de ditado ou inicia uma
                  chamada de voz. O áudio vai para o provedor de transcrição (voz para texto) que
                  você configurou e não é armazenado por nós.
                </li>
                <li>
                  <B>Fotos e arquivos</B>: apenas os itens que você escolhe anexar.
                </li>
                <li>
                  <B>Notificações</B>: para exibir os avisos do app no seu celular.
                </li>
                <li>
                  <B>Biometria</B>: o desbloqueio por digital ou rosto é feito pelo próprio Android;
                  nunca recebemos dados biométricos.
                </li>
                <li>
                  <B>Rede</B>: para sincronizar com o servidor e falar com os provedores que você
                  configurou.
                </li>
              </List>
            </Section>

            <Section id="finalidades">
              <List>
                <li>
                  <B>Prestar o serviço</B> (criar e manter a conta, autenticar, sincronizar seus
                  dados cifrados entre dispositivos, entregar notificações): execução de contrato e
                  procedimentos preliminares (art. 7º, V, da LGPD).
                </li>
                <li>
                  <B>Segurança e prevenção de abuso</B> (registro de atividade de segurança,
                  verificação anti-robô, lista de dispositivos com IP e último acesso): legítimo
                  interesse (art. 7º, IX) e exercício regular de direitos (art. 7º, VI).
                </li>
                <li>
                  <B>Cumprimento de obrigações legais</B>, quando aplicável (art. 7º, II).
                </li>
              </List>
            </Section>

            <Section id="nao-fazemos">
              <List>
                <li>Não exibimos anúncios.</li>
                <li>Não usamos SDKs de análise (analytics) nem de rastreamento.</li>
                <li>Não vendemos dados pessoais nem os compartilhamos para fins de marketing.</li>
              </List>
            </Section>

            <Section id="retencao">
              <List>
                <li>
                  <B>Dados da conta</B>: mantidos enquanto a conta existir.
                </li>
                <li>
                  <B>Registros apagados</B>: deixam uma marca de exclusão, sem conteúdo, por até 180
                  dias, para que os outros dispositivos saibam que o item foi removido.
                </li>
                <li>
                  <B>Registro de atividade de segurança</B> (entrada, saída, revogação de
                  dispositivo, com IP): 90 dias.
                </li>
                <li>
                  <B>Códigos enviados por e-mail</B>: apagados depois que expiram.
                </li>
                <li>
                  <B>Exclusão da conta</B>: remove imediatamente do servidor o usuário, os
                  dispositivos, todos os registros cifrados e os anexos. Pode permanecer, por até 90
                  dias, apenas um registro anônimo de “conta excluída” com o endereço IP.
                </li>
              </List>
            </Section>

            <section
              id="excluir-conta"
              className="scroll-mt-6 rounded-2xl border border-accent/30 bg-accent-soft/60 p-5 sm:p-6"
            >
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg sm:text-xl">
                <Trash2 className="size-5 shrink-0 text-accent-strong" />
                <a href="#excluir-conta" className="rounded hover:text-accent-strong">
                  Como excluir sua conta
                </a>
              </h2>
              <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-muted">
                <p>Você pode apagar sua conta e todos os dados dela de duas formas:</p>
                <h3 className="font-medium text-fg">Pelo site</h3>
                <ol className="list-decimal space-y-1.5 pl-5 marker:text-subtle">
                  <li>
                    Entre em <Ext href={SITE}>clear.ezenere.com</Ext>.
                  </li>
                  <li>
                    Abra <B>Conta</B> (
                    <Ext href={`${SITE}/app/account`}>clear.ezenere.com/app/account</Ext>).
                  </li>
                  <li>
                    Clique em <B>Apagar conta</B>.
                  </li>
                  <li>Confirme com o código enviado para o seu e-mail.</li>
                </ol>
                <h3 className="pt-1 font-medium text-fg">Por e-mail</h3>
                <p>
                  Envie um pedido de exclusão para <ContactLink />{' '}
                  <B>a partir do endereço de e-mail da conta</B>.
                </p>
                <h3 className="pt-1 font-medium text-fg">O que é apagado</h3>
                <p>
                  A exclusão remove imediatamente do servidor o usuário, os dispositivos, todos os
                  registros cifrados e os anexos. Pode permanecer, por até 90 dias, apenas um
                  registro anônimo de “conta excluída” com o endereço IP, para fins de segurança.
                </p>
                <h3 className="pt-1 font-medium text-fg">Dados nos seus aparelhos</h3>
                <p>
                  Desinstalar o app Android apaga os dados locais do celular. No computador, os
                  dados do app desktop continuam lá até que você os apague.
                </p>
              </div>
            </section>

            <Section id="direitos">
              <p>Pela LGPD (art. 18), você pode pedir a qualquer momento:</p>
              <List>
                <li>
                  <B>Confirmação e acesso</B> aos seus dados pessoais;
                </li>
                <li>
                  <B>Correção</B> de dados incompletos, inexatos ou desatualizados;
                </li>
                <li>
                  <B>Exclusão</B> dos dados (veja{' '}
                  <a
                    href="#excluir-conta"
                    className="text-accent-strong underline decoration-accent/40 underline-offset-2"
                  >
                    Como excluir sua conta
                  </a>
                  );
                </li>
                <li>
                  <B>Portabilidade</B> dos dados a outro fornecedor;
                </li>
                <li>
                  <B>Informação</B> sobre com quem os dados são compartilhados e sobre as
                  consequências de não fornecer consentimento, quando for o caso.
                </li>
              </List>
              <p>
                Para exercer esses direitos, escreva para <ContactLink /> a partir do e-mail da sua
                conta. Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).
              </p>
            </Section>

            <Section id="menores">
              <p>
                O ClearChat não é direcionado a crianças e adolescentes. Menores de 18 anos não
                devem usar o serviço sem o consentimento dos pais ou responsáveis legais. Se você é
                responsável por um menor que criou uma conta sem esse consentimento, escreva para{' '}
                <ContactLink /> para pedir a exclusão.
              </p>
            </Section>

            <Section id="auto-hospedagem">
              <p>
                O servidor do ClearChat é de código aberto e pode ser hospedado por qualquer pessoa.
                Outras instâncias são operadas pelos seus próprios responsáveis, que definem suas
                próprias regras. <B>Esta política cobre apenas clear.ezenere.com</B>.
              </p>
            </Section>

            <Section id="alteracoes">
              <p>
                Quando esta política mudar, a nova versão será publicada nesta página com uma nova
                data de “Última atualização”.
              </p>
            </Section>

            <Section id="contato">
              <p>
                Dúvidas, pedidos ou reclamações sobre privacidade:{' '}
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-4 shrink-0 text-subtle" />
                  <ContactLink />
                </span>
              </p>
            </Section>
          </div>
        </main>
      </div>

      <footer className="border-t border-border px-4 py-8 text-center text-[13px] text-subtle sm:px-8">
        ClearChat · instância oficial em clear.ezenere.com ·{' '}
        <Link to="/" className="hover:text-fg">
          Início
        </Link>
      </footer>
    </div>
  )
}
