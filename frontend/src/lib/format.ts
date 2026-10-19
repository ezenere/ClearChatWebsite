// Formatação pt-BR (tamanhos, datas relativas).
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const s = v >= 100 || i === 0 ? Math.round(v).toString() : v.toFixed(1).replace('.', ',')
  return `${s} ${units[i]}`
}

const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })
const df = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })

export const formatDateTime = (t: number | string): string => dtf.format(new Date(t))
export const formatDate = (t: number | string): string => df.format(new Date(t))

export function relativeTime(t: number | string, now = Date.now()): string {
  const ms = typeof t === 'number' ? t : Date.parse(t)
  if (!Number.isFinite(ms)) return '—'
  const s = Math.round((now - ms) / 1000)
  if (s < 45) return 'agora'
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  if (d === 1) return 'ontem'
  if (d < 7) return `há ${d} dias`
  return formatDate(ms)
}

export function maskSecret(s: string): string {
  if (!s) return '—'
  if (s.length <= 8) return '•'.repeat(s.length)
  return `${s.slice(0, 4)}${'•'.repeat(8)}${s.slice(-4)}`
}
