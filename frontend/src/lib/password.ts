// Política e medidor de força da senha de criptografia (SYNC_PROTOCOL.md §3.4: ≥ 10 caracteres,
// diferente do e-mail; medidor recomendado). Heurística local — nada sai do navegador.

const COMMON = [
  'senha',
  'password',
  'passw0rd',
  'qwerty',
  'asdf',
  'zxcv',
  'abc123',
  'admin',
  'iloveyou',
  'teamo',
  'brasil',
  'clearchat',
  'letmein',
  'welcome',
  'dragon',
  'monkey',
  'futebol',
  'flamengo',
  'corinthians',
  'palmeiras',
  'mudar',
  'segredo'
]
const SEQS = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

export interface Strength {
  score: 0 | 1 | 2 | 3 | 4
  label: string
  errors: string[]
  hints: string[]
  ok: boolean
}

const LABELS = ['Muito fraca', 'Fraca', 'Razoável', 'Boa', 'Forte']

function charsetSize(pw: string): number {
  let n = 0
  if (/[a-z]/.test(pw)) n += 26
  if (/[A-Z]/.test(pw)) n += 26
  if (/[0-9]/.test(pw)) n += 10
  if (/[ ]/.test(pw)) n += 1
  if (/[!-/:-@[-`{-~]/.test(pw)) n += 33
  if (/[^\x20-\x7e]/.test(pw)) n += 60
  return Math.max(n, 1)
}

function sequencePenalty(lower: string): number {
  let run = 0
  for (const seq of SEQS)
    for (let len = Math.min(lower.length, 8); len >= 3; len--)
      for (let i = 0; i + len <= seq.length; i++) {
        const sub = seq.slice(i, i + len)
        const rev = [...sub].reverse().join('')
        if (lower.includes(sub) || lower.includes(rev)) {
          run = Math.max(run, len)
          break
        }
      }
  return run
}

export function passwordStrength(pw: string, email = ''): Strength {
  const errors: string[] = []
  const hints: string[] = []
  const len = [...pw].length
  const lower = pw.toLowerCase()
  if (len < 10) errors.push('Use pelo menos 10 caracteres.')
  const em = email.trim().toLowerCase()
  if (em && (lower === em || lower === em.split('@')[0]))
    errors.push('A senha não pode ser o seu e-mail.')

  let bits = len * Math.log2(charsetSize(pw))
  const unique = new Set(pw).size
  if (unique / Math.max(len, 1) < 0.5) {
    bits *= 0.6
    hints.push('Evite repetir os mesmos caracteres.')
  }
  const seq = sequencePenalty(lower)
  if (seq >= 4) {
    bits -= seq * 3.5
    hints.push('Evite sequências como "1234" ou "abcd".')
  }
  for (const w of COMMON)
    if (lower.includes(w)) {
      bits -= w.length * 3.2
      hints.push(`Evite palavras óbvias como "${w}".`)
      break
    }
  const local = em.split('@')[0]
  if (local.length >= 4 && lower.includes(local)) {
    bits -= local.length * 3
    hints.push('Não use partes do seu e-mail.')
  }
  const words = pw
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
  if (words.length >= 4) bits += 8 // frase-senha
  if (len >= 10 && len < 14 && hints.length === 0)
    hints.push('Frases com 4 ou mais palavras são fáceis de lembrar e difíceis de adivinhar.')

  const score = (
    bits < 38 ? 0 : bits < 52 ? 1 : bits < 64 ? 2 : bits < 80 ? 3 : 4
  ) as Strength['score']
  if (len >= 10 && score === 0) errors.push('Senha fácil demais de adivinhar.')
  return {
    score,
    label: LABELS[score],
    errors,
    hints: [...new Set(hints)],
    ok: errors.length === 0
  }
}
