// Downloads: última release do app no GitHub (consulta pública da API, no navegador) com fallback para
// a página de releases configurada na instância (`links.download`).

export type OS = 'windows' | 'mac' | 'linux' | 'android' | 'ios' | null

export function detectOS(ua = navigator.userAgent): OS {
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux'
  return null
}

export interface Asset {
  name: string
  url: string
  size: number
}
export interface Release {
  version: string | null
  pageUrl: string
  publishedAt: string | null
  windows?: Asset
  macArm?: Asset
  macX64?: Asset
  appImage?: Asset
  deb?: Asset
  pacman?: Asset
  tarGz?: Asset
}

export const DEFAULT_RELEASES = 'https://github.com/ezenere/ClearChat/releases'

export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/.*)?$/.exec(
    url
  )
  return m ? { owner: m[1], repo: m[2] } : null
}

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}

export function classifyAssets(
  assets: GhAsset[]
): Omit<Release, 'version' | 'pageUrl' | 'publishedAt'> {
  const out: Omit<Release, 'version' | 'pageUrl' | 'publishedAt'> = {}
  for (const a of assets) {
    const n = a.name
    const asset = { name: n, url: a.browser_download_url, size: a.size }
    if (/\.blockmap$|\.yml$|\.sig$|\.sha\d+$/i.test(n)) continue
    if (/\.exe$/i.test(n)) out.windows ??= asset
    else if (/\.dmg$/i.test(n)) {
      if (/arm64|aarch64|apple-?silicon/i.test(n)) out.macArm ??= asset
      else if (/x64|x86_64|intel|amd64/i.test(n)) out.macX64 ??= asset
      else if (/universal/i.test(n)) {
        out.macArm ??= asset
        out.macX64 ??= asset
      } else out.macX64 ??= asset
    } else if (/\.AppImage$/i.test(n)) out.appImage ??= asset
    else if (/\.deb$/i.test(n)) out.deb ??= asset
    else if (/\.pacman$|\.pkg\.tar\.(zst|xz)$/i.test(n)) out.pacman ??= asset
    else if (/\.tar\.gz$/i.test(n)) out.tarGz ??= asset
  }
  return out
}

const cache = new Map<string, Promise<Release>>()

export function fetchLatestRelease(
  downloadUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<Release> {
  const page = downloadUrl.replace(/\/+$/, '')
  const repo = parseGithubRepo(page)
  const fallback: Release = {
    version: null,
    pageUrl: repo ? `${page.replace(/\/latest$/, '')}/latest` : page,
    publishedAt: null
  }
  if (!repo) return Promise.resolve(fallback)
  const key = `${repo.owner}/${repo.repo}`
  if (!cache.has(key))
    cache.set(
      key,
      fetchFn(`https://api.github.com/repos/${key}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        referrerPolicy: 'no-referrer'
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status))
          const j = (await r.json()) as {
            tag_name?: string
            html_url?: string
            published_at?: string
            assets?: GhAsset[]
          }
          return {
            version: j.tag_name ?? null,
            pageUrl: j.html_url ?? fallback.pageUrl,
            publishedAt: j.published_at ?? null,
            ...classifyAssets(j.assets ?? [])
          }
        })
        .catch(() => fallback)
    )
  return cache.get(key)!
}
