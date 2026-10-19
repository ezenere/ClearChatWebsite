// Instância única do cliente da API. Com `VITE_MOCK_API=1` (só dev/testes) troca fetch e WebSocket
// pelo servidor simulado de src/mock — o import é dinâmico e some do build de produção.
import { ApiClient, type FetchFn } from './client'
import { apiRoot, SITE_VERSION } from './config'
import type { SocketFactory } from './ws'

let client: ApiClient | null = null
let socketFactory: SocketFactory | undefined

export const MOCK = import.meta.env.VITE_MOCK_API === '1'

export async function initApi(): Promise<ApiClient> {
  if (client) return client
  let fetchFn: FetchFn | undefined
  if (import.meta.env.VITE_MOCK_API === '1') {
    const { installMock } = await import('../mock/install')
    const mock = await installMock(apiRoot())
    fetchFn = mock.fetch
    socketFactory = mock.socketFactory
  }
  client = new ApiClient({ root: apiRoot(), fetch: fetchFn, clientHeader: `web/${SITE_VERSION}` })
  return client
}

export function api(): ApiClient {
  if (!client) throw new Error('initApi() ainda não foi chamado')
  return client
}

export function getSocketFactory(): SocketFactory | undefined {
  return socketFactory
}

export { ApiError, isApiError } from './client'
