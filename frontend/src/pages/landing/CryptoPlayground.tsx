// Sync ao vivo: o que você digita é cifrado de verdade aqui no navegador (o mesmo envelope
// AES-256-GCM do protocolo), o "servidor" mostra só o envelope e o "notebook" decifra com a chave.
import { useEffect, useRef, useState } from 'react'
import { KeyRound, Laptop, LockKeyhole, Server } from 'lucide-react'
import { type Envelope, frameJson, seal, unframeJson } from '../../crypto/envelope'
import { aadRecord } from '../../crypto/keys'
import { gcmDecrypt, randomBytes } from '../../crypto/primitives'
import { fromB64u } from '../../crypto/encoding'
import { Scramble } from './fx'

const USER = 'u_demo'
const CHAT = 'c_demo'
const MSG = 'm_demo'

function Beam() {
  return (
    <div aria-hidden className="beam">
      <span />
      <span />
      <span />
    </div>
  )
}

export function CryptoPlayground() {
  const [text, setText] = useState('Lembra de renovar o domínio na sexta 🔑')
  const [env, setEnv] = useState<Envelope | null>(null)
  const [rev, setRev] = useState(1)
  const [decoded, setDecoded] = useState('')
  const [pulse, setPulse] = useState(0)
  const [unsupported, setUnsupported] = useState(false)
  const key = useRef<Uint8Array | null>(null)

  useEffect(() => {
    if (!globalThis.crypto?.subtle) {
      queueMicrotask(() => setUnsupported(true))
      return
    }
    key.current ??= randomBytes(32)
    let alive = true
    const id = setTimeout(async () => {
      const k = key.current!
      const nextRev = rev + 1
      const aad = aadRecord(USER, 'message', MSG, CHAT, nextRev)
      const json = JSON.stringify({ role: 'user', content: text })
      const e = await seal(k, aad, await frameJson(json, false))
      // o outro dispositivo: decifra só com a chave (e a mesma AAD)
      const plain = await unframeJson(await gcmDecrypt(k, fromB64u(e.n), aad, fromB64u(e.c)))
      if (!alive) return
      setEnv(e)
      setRev(nextRev)
      setDecoded(String(plain.content ?? ''))
      setPulse((p) => p + 1)
    }, 160)
    return () => {
      alive = false
      clearTimeout(id)
    }
    // rev é consequência da cifragem, não gatilho
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const envText = env
    ? `{ "type": "message", "rev": ${rev},\n  "env": { "v": ${env.v}, "k": ${env.k},\n    "n": "${env.n}",\n    "c": "${env.c}" } }`
    : '…'

  return (
    <div className="grid items-stretch gap-3 lg:grid-cols-[1fr_auto_1.25fr_auto_1fr] [&>*]:min-w-0">
      <div className="glass flex flex-col rounded-2xl p-4">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-2 text-muted">
            <Laptop className="size-4" /> PC de casa
          </span>
          <span className="font-mono text-[11px] text-success">texto claro</span>
        </div>
        <label className="mt-3 block text-[12px] text-subtle" htmlFor="crypto-demo-input">
          Digite qualquer coisa:
        </label>
        <textarea
          id="crypto-demo-input"
          value={text}
          maxLength={280}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          className="field mt-1.5 flex-1 resize-none text-[15px]"
        />
      </div>

      <Beam key={`a${pulse}`} />

      <div className="glass relative flex flex-col overflow-hidden rounded-2xl border-accent/30 p-4">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-2 text-accent-strong">
            <Server className="size-4" /> Servidor
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-accent-strong">
            <LockKeyhole className="size-3" /> só cifrado
          </span>
        </div>
        <pre className="mt-3 flex-1 overflow-hidden font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-subtle">
          <Scramble text={envText} speed={2.2} />
        </pre>
        <p className="mt-2 text-[11.5px] text-faint">
          AES-256-GCM, nonce novo a cada mudança — o mesmo texto nunca gera o mesmo envelope.
        </p>
      </div>

      <Beam key={`b${pulse}`} />

      <div className="glass flex flex-col rounded-2xl p-4">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-2 text-muted">
            <Laptop className="size-4" /> Notebook
          </span>
          <span className="font-mono text-[11px] text-success">decifrado</span>
        </div>
        <div className="mt-3 flex-1 rounded-xl rounded-tr-sm border border-border bg-elevated px-3.5 py-2.5 text-[15px] break-words text-fg">
          {decoded || <span className="text-faint">…</span>}
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-faint">
          <KeyRound className="size-3" /> com a chave que só os seus dispositivos têm
        </p>
      </div>

      {unsupported && (
        <p className="text-[12.5px] text-warning lg:col-span-5">
          Este endereço não é seguro (sem HTTPS), então o navegador não libera a criptografia da
          demonstração.
        </p>
      )}
    </div>
  )
}
