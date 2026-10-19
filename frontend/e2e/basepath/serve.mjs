// Serve o build (dist-mock) sob um caminho de base, como o container faz em produção
// (docker/40-clearchat-site.sh): config.js com a baseUrl, <base href> e fallback da SPA.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const PORT = Number(process.env.PORT ?? 5198)
const BASE = '/clearchat'
const DIR = new URL('../../dist-mock/', import.meta.url).pathname
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

const index = (await readFile(join(DIR, 'index.html'), 'utf8')).replace(
  /<base href="\/" *\/?>/,
  `<base href="${BASE}/" />`
)

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (!url.pathname.startsWith(BASE + '/')) {
    res.writeHead(404).end('fora do caminho de base')
    return
  }
  const rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(
    /^(\.\.[/\\])+/,
    ''
  )
  if (rel === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    res.end(`window.__CLEARCHAT__ = { baseUrl: "http://127.0.0.1:${PORT}${BASE}" }\n`)
    return
  }
  const file = join(DIR, rel)
  try {
    if (rel !== '/' && (await stat(file)).isFile()) {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(await readFile(file))
      return
    }
  } catch {
    /* fallback da SPA */
  }
  res.writeHead(200, { 'Content-Type': TYPES['.html'] })
  res.end(index)
}).listen(PORT, '127.0.0.1')
