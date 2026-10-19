// Pesquisa na web: chaves de API dos buscadores (registro `setting webSearchApiKeys`, §4.3.2) e a ordem
// configurada no app (`setting webSearchEngines`, só leitura aqui).
import { useState, type FormEvent } from 'react'
import { ExternalLink, Save } from 'lucide-react'
import { toast } from '../../components/toast'
import { Alert, Badge, Button, Card, Field, PasswordInput, Spinner } from '../../components/ui'
import type { Entry } from '../../data/repo'
import {
  API_ENGINES,
  type ApiEngineId,
  type SettingPlain,
  type WebSearchApiKeys
} from '../../data/schemas'
import { errorMessage } from '../../lib/errors'
import { useAsync } from '../../lib/useAsync'
import { useLiveRefresh } from '../../state/live'
import { useSession } from '../../state/session'
import { PageHeader } from './PanelLayout'

const ENGINE_LABEL: Record<string, string> = {
  ddg: 'DuckDuckGo',
  'brave-site': 'Brave (site)',
  'brave-api': 'Brave Search API',
  exa: 'Exa',
  tavily: 'Tavily'
}

interface EngineCfg {
  id: string
  enabled: boolean
}

export default function Search() {
  const repo = useSession((s) => s.vault!.repo)
  const { data, error, loading, reload } = useAsync(async () => {
    const { records } = await repo.api.fetchRecords([
      { type: 'setting', id: 'webSearchApiKeys' },
      { type: 'setting', id: 'webSearchEngines' }
    ])
    const full = await repo.fillOmitted(records.filter((r) => !r.deleted))
    const out: { keys: Entry<SettingPlain<WebSearchApiKeys>> | null; engines: EngineCfg[] | null } =
      {
        keys: null,
        engines: null
      }
    for (const c of full) {
      const plain = await repo.decrypt<SettingPlain>(c)
      if (c.id === 'webSearchApiKeys')
        out.keys = { change: c, plain: plain as SettingPlain<WebSearchApiKeys> }
      if (c.id === 'webSearchEngines' && Array.isArray(plain.value))
        out.engines = plain.value as EngineCfg[]
    }
    return out
  }, [repo])
  const [edits, setEdits] = useState<WebSearchApiKeys>({})
  const [busy, setBusy] = useState(false)
  useLiveRefresh(['setting'], () => void reload(true))

  const current = data?.keys?.plain.value ?? {}
  const draft: WebSearchApiKeys = { ...current, ...edits }
  const dirty = API_ENGINES.some((e) => (draft[e.id] ?? '') !== (current[e.id] ?? ''))

  const save = async (ev: FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    try {
      const changed = API_ENGINES.filter((e) => (draft[e.id] ?? '') !== (current[e.id] ?? '')).map(
        (e) => e.id
      )
      await repo.save<SettingPlain<WebSearchApiKeys>>(
        { type: 'setting', id: 'webSearchApiKeys', scope: null },
        data?.keys ?? null,
        (cur) => {
          // reaplica só as chaves editadas por cima do valor atual (setting nunca é tombstone)
          const value: WebSearchApiKeys = { ...(cur?.value ?? {}) }
          for (const id of changed) {
            const v = (draft[id] ?? '').trim()
            if (v) value[id] = v
            else delete value[id]
          }
          return { ...(cur ?? {}), sv: 1, value }
        }
      )
      toast('Chaves salvas.')
      setEdits({})
      await reload(true)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Pesquisa na web"
        description="Chaves dos buscadores com API usados pela ferramenta web_search do app. Ficam cifradas como o resto."
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {loading && !data ? (
        <div className="py-16 text-center">
          <Spinner label="Decifrando configurações…" />
        </div>
      ) : (
        <div className="space-y-5">
          <Card title="Chaves de API" description="Deixe em branco para remover a chave.">
            <form onSubmit={save} className="space-y-4">
              {API_ENGINES.map((e) => (
                <Field
                  key={e.id}
                  label={e.label}
                  right={
                    <a
                      href={e.site}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] text-subtle hover:text-fg"
                    >
                      site <ExternalLink className="size-3" />
                    </a>
                  }
                >
                  {(id) => (
                    <PasswordInput
                      id={id}
                      value={draft[e.id] ?? ''}
                      onChange={(ev) =>
                        setEdits((d) => ({ ...d, [e.id as ApiEngineId]: ev.target.value }))
                      }
                      placeholder={e.hint}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                    />
                  )}
                </Field>
              ))}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy}
                  disabled={!dirty}
                  icon={<Save className="size-4" />}
                >
                  Salvar chaves
                </Button>
              </div>
            </form>
          </Card>
          <Card
            title="Ordem dos buscadores"
            description="A ordem (prioridade, com fallback) e quais ficam ligados são configurados no app, em Configurações → Pesquisa na web."
          >
            {data?.engines?.length ? (
              <ol className="space-y-2">
                {data.engines.map((e, i) => (
                  <li key={e.id} className="flex items-center gap-3 text-sm">
                    <span className="flex size-6 items-center justify-center rounded-md bg-elevated font-mono text-[12px] text-subtle">
                      {i + 1}
                    </span>
                    <span className={e.enabled ? 'text-fg' : 'text-subtle line-through'}>
                      {ENGINE_LABEL[e.id] ?? e.id}
                    </span>
                    {e.enabled ? <Badge tone="success">ligado</Badge> : <Badge>desligado</Badge>}
                    {API_ENGINES.some((a) => a.id === e.id) &&
                      !current[e.id as ApiEngineId] &&
                      e.enabled && <Badge tone="warning">sem chave</Badge>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-subtle">
                Nenhuma ordem sincronizada ainda (o app usa o padrão).
              </p>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
