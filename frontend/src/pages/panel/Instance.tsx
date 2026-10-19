// Informações da instância (GET /api/info) e o que o servidor consegue ver.
import { CheckCircle2, CircleSlash, ExternalLink, EyeOff } from 'lucide-react'
import { publicBaseUrl, SITE_VERSION } from '../../api/config'
import { PROTOCOL } from '../../api/client'
import { Alert, Badge, Card } from '../../components/ui'
import { useSession } from '../../state/session'
import { PageHeader } from './PanelLayout'

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {on ? (
        <CheckCircle2 className="size-4 text-success" />
      ) : (
        <CircleSlash className="size-4 text-faint" />
      )}
      <span className={on ? 'text-fg' : 'text-subtle'}>{label}</span>
    </li>
  )
}

export default function Instance() {
  const info = useSession((s) => s.info)
  if (!info) return null
  const compatible = PROTOCOL >= info.protocol.min && PROTOCOL <= info.protocol.max
  return (
    <>
      <PageHeader
        title="Instância"
        description="O servidor de sync em que esta conta vive. Qualquer pessoa pode hospedar o seu."
      />
      <div className="space-y-5">
        <Card title={info.name}>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="text-subtle">Endereço</dt>
            <dd className="font-mono text-[13px] break-all">{info.base_url || publicBaseUrl()}</dd>
            <dt className="text-subtle">Versão do servidor</dt>
            <dd className="font-mono text-[13px]">{info.server_version}</dd>
            <dt className="text-subtle">Protocolo</dt>
            <dd className="flex flex-wrap items-center gap-2 font-mono text-[13px]">
              {info.protocol.version} (v{info.protocol.min}–v{info.protocol.max})
              {compatible ? (
                <Badge tone="success">compatível</Badge>
              ) : (
                <Badge tone="danger">incompatível</Badge>
              )}
            </dd>
            <dt className="text-subtle">Site</dt>
            <dd className="font-mono text-[13px]">
              {SITE_VERSION} · protocolo v{PROTOCOL}
            </dd>
          </dl>
          {!compatible && (
            <Alert tone="danger" className="mt-4">
              Este servidor usa uma versão incompatível do protocolo (servidor {info.protocol.min}–
              {info.protocol.max}, site {PROTOCOL}). Atualize o servidor ou o site.
            </Alert>
          )}
          <ul className="mt-5 grid gap-2 sm:grid-cols-2">
            <Flag on={info.features.signupOpen} label="Cadastro aberto" />
            <Flag on={!!info.features.captcha} label="Captcha (Turnstile)" />
            <Flag on={info.features.landing} label="Página inicial pública" />
          </ul>
          {info.links.download && (
            <a
              href={info.links.download}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-1.5 text-sm text-accent-strong hover:underline"
            >
              Baixar o app <ExternalLink className="size-3.5" />
            </a>
          )}
        </Card>
        <Card
          title="O que o servidor vê"
          description="Zero-knowledge: tudo que é seu é cifrado antes de sair do dispositivo."
        >
          <div className="grid gap-5 text-sm sm:grid-cols-2">
            <div>
              <p className="mb-2 flex items-center gap-1.5 font-medium text-muted">Em claro</p>
              <ul className="list-disc space-y-1 pl-5 text-subtle">
                <li>e-mail e nome da conta</li>
                <li>dispositivos (nome, plataforma, último acesso)</li>
                <li>tipos, ids e tamanhos dos registros</li>
                <li>quais mensagens pertencem ao mesmo chat</li>
              </ul>
            </div>
            <div>
              <p className="mb-2 flex items-center gap-1.5 font-medium text-muted">
                <EyeOff className="size-4 text-success" /> Cifrado (ilegível para o servidor)
              </p>
              <ul className="list-disc space-y-1 pl-5 text-subtle">
                <li>conteúdo das mensagens e títulos</li>
                <li>chaves de API e configurações</li>
                <li>memórias, skills e anexos</li>
                <li>sua senha e a chave de recuperação (nunca enviadas)</li>
              </ul>
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}
