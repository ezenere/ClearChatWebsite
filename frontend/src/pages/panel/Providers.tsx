// Provedores (registros `provider`): listar, adicionar, editar (incl. chave de API) e apagar.
import { useState, type FormEvent } from 'react'
import { AudioLines, Eye, EyeOff, KeyRound, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from '../../components/toast'
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  PasswordInput,
  Spinner
} from '../../components/ui'
import type { Entry } from '../../data/repo'
import {
  isChatProviderKind,
  PROVIDER_KIND_DEFAULT_URL,
  PROVIDER_KIND_LABEL,
  PROVIDER_KINDS,
  providerKindOf,
  type ProviderKind,
  type ProviderPlain
} from '../../data/schemas'
import { errorMessage } from '../../lib/errors'
import { maskSecret } from '../../lib/format'
import { useAsync } from '../../lib/useAsync'
import { useLiveRefresh } from '../../state/live'
import { useSession } from '../../state/session'
import { PageHeader } from './PanelLayout'

interface Draft {
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  headers: { k: string; v: string }[]
}

const emptyDraft = (): Draft => ({
  name: '',
  kind: 'openrouter',
  baseUrl: PROVIDER_KIND_DEFAULT_URL.openrouter,
  apiKey: '',
  headers: []
})

function toDraft(p: ProviderPlain): Draft {
  return {
    name: p.name ?? '',
    kind: providerKindOf(p),
    baseUrl: p.baseUrl ?? '',
    apiKey: p.apiKey ?? '',
    headers: Object.entries(p.headers ?? {}).map(([k, v]) => ({ k, v: String(v) }))
  }
}

function validUrl(u: string): boolean {
  try {
    const x = new URL(u)
    return x.protocol === 'https:' || x.protocol === 'http:'
  } catch {
    return false
  }
}

function ProviderForm({
  initial,
  onCancel,
  onSave
}: {
  initial: Draft
  onCancel: () => void
  onSave: (d: Draft) => Promise<void>
}) {
  const [d, setD] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const urlBad = d.baseUrl.trim() !== '' && !validUrl(d.baseUrl.trim())
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!d.name.trim() || !validUrl(d.baseUrl.trim())) return
    setBusy(true)
    setError(null)
    try {
      await onSave({
        ...d,
        name: d.name.trim(),
        baseUrl: d.baseUrl.trim().replace(/\/+$/, ''),
        headers: d.headers.filter((h) => h.k.trim())
      })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4" id="provider-form">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Nome">
        {(id) => (
          <Input
            id={id}
            value={d.name}
            onChange={(e) => set('name', e.target.value)}
            required
            maxLength={80}
            placeholder="Ex.: OpenRouter"
          />
        )}
      </Field>
      <Field
        label="Tipo"
        hint={
          isChatProviderKind(d.kind)
            ? 'Define o adaptador usado pelo app.'
            : 'Provedor de voz (fala) — não aparece nos modelos de chat.'
        }
      >
        {(id) => (
          <select
            id={id}
            className="field"
            value={d.kind}
            onChange={(e) => {
              const kind = e.target.value as ProviderKind
              const wasDefault =
                Object.values(PROVIDER_KIND_DEFAULT_URL).includes(d.baseUrl) || !d.baseUrl
              setD((x) => ({
                ...x,
                kind,
                baseUrl: wasDefault ? PROVIDER_KIND_DEFAULT_URL[kind] : x.baseUrl
              }))
            }}
          >
            {PROVIDER_KINDS.map((k) => (
              <option key={k} value={k}>
                {PROVIDER_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="URL base"
        error={urlBad ? 'URL inválida (use http:// ou https://).' : undefined}
      >
        {(id) => (
          <Input
            id={id}
            value={d.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            required
            inputMode="url"
            spellCheck={false}
            className="font-mono"
          />
        )}
      </Field>
      <Field
        label="Chave de API"
        hint="Fica cifrada: só quem tem a sua senha de criptografia consegue lê-la."
      >
        {(id) => (
          <PasswordInput
            id={id}
            value={d.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="sk-…"
          />
        )}
      </Field>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-muted">Cabeçalhos extras</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<Plus className="size-3.5" />}
            onClick={() => set('headers', [...d.headers, { k: '', v: '' }])}
          >
            Adicionar
          </Button>
        </div>
        {d.headers.map((h, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={h.k}
              placeholder="Nome"
              aria-label="Nome do cabeçalho"
              className="font-mono"
              onChange={(e) =>
                set(
                  'headers',
                  d.headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x))
                )
              }
            />
            <Input
              value={h.v}
              placeholder="Valor"
              aria-label="Valor do cabeçalho"
              className="font-mono"
              onChange={(e) =>
                set(
                  'headers',
                  d.headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x))
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              aria-label="Remover cabeçalho"
              onClick={() =>
                set(
                  'headers',
                  d.headers.filter((_, j) => j !== i)
                )
              }
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!d.name.trim() || !validUrl(d.baseUrl.trim())}
        >
          Salvar
        </Button>
      </div>
    </form>
  )
}

function ProviderCard({
  entry,
  onEdit,
  onDelete
}: {
  entry: Entry<ProviderPlain>
  onEdit: () => void
  onDelete: () => void
}) {
  const [reveal, setReveal] = useState(false)
  const p = entry.plain
  const kind = providerKindOf(p)
  const voiceOnly = !isChatProviderKind(kind)
  return (
    <li
      className="rounded-2xl border border-border bg-surface p-4 sm:p-5"
      data-testid="provider-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold">{p.name || 'Sem nome'}</h3>
            <Badge tone="accent">{PROVIDER_KIND_LABEL[kind]}</Badge>
            {voiceOnly && (
              <Badge tone="success">
                <AudioLines className="size-3" aria-hidden /> Voz
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-[12.5px] text-subtle">{p.baseUrl}</p>
          {voiceOnly && (
            <p className="mt-1 text-[12px] text-subtle">
              Provedor de voz (fala) — não aparece nos modelos de chat.
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            aria-label={`Editar ${p.name}`}
            icon={<Pencil className="size-3.5" />}
          >
            <span className="hidden sm:inline">Editar</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            aria-label={`Apagar ${p.name}`}
            className="hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-bg/50 px-3 py-2">
        <KeyRound className="size-3.5 shrink-0 text-subtle" />
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted">
          {p.apiKey ? (reveal ? p.apiKey : maskSecret(p.apiKey)) : 'sem chave'}
        </code>
        {p.apiKey && (
          <button
            onClick={() => setReveal((r) => !r)}
            className="text-subtle hover:text-fg"
            aria-label={reveal ? 'Ocultar chave' : 'Mostrar chave'}
          >
            {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
      </div>
      {Object.keys(p.headers ?? {}).length > 0 && (
        <p className="mt-2 text-[12px] text-subtle">
          {Object.keys(p.headers).length} cabeçalho(s) extra(s): {Object.keys(p.headers).join(', ')}
        </p>
      )}
    </li>
  )
}

export default function Providers() {
  const repo = useSession((s) => s.vault!.repo)
  const { data, error, loading, reload } = useAsync(
    () => repo.listDecrypted<ProviderPlain>('provider'),
    [repo]
  )
  const [editing, setEditing] = useState<Entry<ProviderPlain> | 'new' | null>(null)
  const [toDelete, setToDelete] = useState<Entry<ProviderPlain> | null>(null)
  const [deleting, setDeleting] = useState(false)
  useLiveRefresh(['provider'], () => void reload(true))

  const save = async (d: Draft) => {
    const headers = Object.fromEntries(d.headers.map((h) => [h.k.trim(), h.v]))
    const fields = { name: d.name, kind: d.kind, baseUrl: d.baseUrl, apiKey: d.apiKey, headers }
    if (editing === 'new') {
      const id = crypto.randomUUID()
      await repo.save<ProviderPlain>({ type: 'provider', id, scope: null }, null, () => ({
        sv: 1,
        ...fields,
        createdAt: Date.now()
      }))
      toast('Provedor adicionado.')
    } else if (editing) {
      // LWW por campo: só os campos editados vão por cima da versão atual (preserva campos desconhecidos)
      const before = toDraft(editing.plain)
      const changed: Partial<ProviderPlain> = {}
      if (before.name !== d.name) changed.name = d.name
      if (before.kind !== d.kind) changed.kind = d.kind
      if (before.baseUrl !== d.baseUrl) changed.baseUrl = d.baseUrl
      if (before.apiKey !== d.apiKey) changed.apiKey = d.apiKey
      if (JSON.stringify(editing.plain.headers ?? {}) !== JSON.stringify(headers))
        changed.headers = headers
      if (Object.keys(changed).length)
        await repo.save<ProviderPlain>(
          { type: 'provider', id: editing.change.id, scope: null },
          editing,
          (cur) => ({ ...(cur as ProviderPlain), ...changed })
        )
      toast('Provedor salvo.')
    }
    setEditing(null)
    await reload(true)
  }

  const remove = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      await repo.remove(toDelete.change)
      toast('Provedor apagado.')
      setToDelete(null)
      await reload(true)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setDeleting(false)
    }
  }

  const list = [...(data?.entries ?? [])].sort(
    (a, b) => (a.plain.createdAt ?? 0) - (b.plain.createdAt ?? 0)
  )
  return (
    <>
      <PageHeader
        title="Provedores"
        description="Endpoints e chaves de API usados pelo app. Mudanças aqui chegam a todos os seus dispositivos."
        actions={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setEditing('new')}
          >
            Adicionar
          </Button>
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {loading && !data ? (
        <div className="py-16 text-center">
          <Spinner label="Decifrando provedores…" />
        </div>
      ) : !list.length ? (
        <EmptyState icon={<Sparkles className="size-5" />} title="Nenhum provedor">
          Adicione um provedor (OpenRouter, Anthropic, ElevenLabs para voz ou qualquer endpoint
          OpenAI-compatible).
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.map((e) => (
            <ProviderCard
              key={e.change.id}
              entry={e}
              onEdit={() => setEditing(e)}
              onDelete={() => setToDelete(e)}
            />
          ))}
        </ul>
      )}
      {data?.broken.length ? (
        <Alert tone="warning" className="mt-4">
          {data.broken.length} provedor(es) não puderam ser decifrados.
        </Alert>
      ) : null}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Novo provedor' : 'Editar provedor'}
        wide
      >
        {editing !== null && (
          <ProviderForm
            initial={editing === 'new' ? emptyDraft() : toDraft(editing.plain)}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        busy={deleting}
        danger
        title="Apagar provedor?"
        confirmLabel="Apagar"
      >
        <p>
          <b className="text-fg">{toDelete?.plain.name}</b> será removido de todos os seus
          dispositivos. Chats que usam este provedor vão pedir outro.
        </p>
      </ConfirmDialog>
    </>
  )
}
