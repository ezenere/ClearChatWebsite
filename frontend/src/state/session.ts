// Estado da sessão do site. Tudo em memória: access token (no ApiClient), chaves embrulhadas e — depois
// do desbloqueio — a DEK e as subchaves. Recarregar a página/fechar a aba = desbloquear de novo
// (SYNC_PROTOCOL.md §3.13). Nada vai para localStorage/sessionStorage.
import { create } from 'zustand'
import { api, getSocketFactory, isApiError } from '../api'
import { wsUrl } from '../api/config'
import type { AuthResult, InstanceInfo, KeysResponse, User } from '../api/types'
import { type SocketStatus, SyncSocket } from '../api/ws'
import { type Bytes, deriveSubkeys, type Subkeys, unlockWithPassword } from '../crypto'
import { Repo } from '../data/repo'
import { kekInWorker } from '../lib/kdf'
import { emitChanges } from './live'

export type Phase = 'boot' | 'anon' | 'needs_setup' | 'locked' | 'unlocked'

export interface Vault {
  dek: Bytes
  sk: Subkeys
  repo: Repo
}

export type LockReason = 'idle' | 'manual' | 'keys_changed' | null

interface SessionState {
  phase: Phase
  info: InstanceInfo | null
  infoError: string | null
  user: User | null
  deviceId: string | null
  keys: KeysResponse | null
  vault: Vault | null
  socket: SocketStatus
  lockReason: LockReason
  /** Motivo de uma saída forçada (dispositivo revogado, conta apagada…), para mostrar no login. */
  endedReason: string | null
  boot: () => Promise<void>
  loadInfo: () => Promise<void>
  applyAuth: (r: AuthResult) => void
  refreshKeys: () => Promise<KeysResponse | null>
  unlock: (password: string) => Promise<void>
  openVault: (dek: Uint8Array) => Promise<void>
  lock: (reason?: LockReason) => void
  logout: () => Promise<void>
  endSession: (reason: string | null) => void
  touch: () => void
  lastActivity: number
}

let socket: SyncSocket | null = null
/** Depois de `keys.reset` o servidor fecha a conexão com 4403 — mas a sessão continua válida. */
let keysResetAt = 0

function wipe(v: Vault | null): void {
  if (!v) return
  v.dek.fill(0)
  for (const k of Object.values(v.sk)) (k as Uint8Array).fill(0)
}

export const useSession = create<SessionState>((set, get) => {
  const startSocket = () => {
    if (socket) return
    socket = new SyncSocket({
      url: wsUrl(),
      factory: getSocketFactory(),
      getToken: () => api().token,
      refresh: () => api().refresh(),
      onStatus: (s) => set({ socket: s }),
      onFatal: (code) => {
        if (code !== 4403) return
        if (Date.now() - keysResetAt < 30_000) {
          socket = null
          setTimeout(() => get().phase !== 'anon' && startSocket(), 1500)
          return
        }
        get().endSession('Sua sessão foi encerrada neste dispositivo.')
      },
      onEvent: (ev) => {
        if (ev.t === 'sync.changes') emitChanges(ev.changes)
        else if (ev.t === 'keys.changed') void get().refreshKeys()
        else if (ev.t === 'keys.reset') {
          keysResetAt = Date.now()
          wipe(get().vault)
          set({ vault: null, keys: null, phase: 'needs_setup' })
        } else if (ev.t === 'account.deleted') get().endSession('A conta foi apagada.')
      }
    })
    socket.start()
  }
  const stopSocket = () => {
    socket?.stop()
    socket = null
  }

  return {
    phase: 'boot',
    info: null,
    infoError: null,
    user: null,
    deviceId: null,
    keys: null,
    vault: null,
    socket: 'idle',
    lockReason: null,
    endedReason: null,
    lastActivity: Date.now(),

    loadInfo: async () => {
      try {
        const info = await api().info()
        set({ info, infoError: null })
      } catch (e) {
        set({
          infoError: isApiError(e)
            ? e.message
            : 'Não foi possível carregar as informações da instância.'
        })
      }
    },

    boot: async () => {
      api().onSessionLost = (reason) => {
        if (get().phase !== 'anon')
          get().endSession(
            reason === 'device_revoked' || reason === 'refresh_reused'
              ? 'Este dispositivo foi desconectado da conta.'
              : reason === 'account_disabled'
                ? 'Esta conta está desativada.'
                : null
          )
      }
      await get().loadInfo()
      // Sessão existente? O refresh vai no cookie HttpOnly (Path=<base>/api/v1/auth).
      try {
        await api().refresh()
        const acc = await api().account()
        const user = { id: acc.id, email: acc.email, name: acc.name }
        if (!acc.keys_ready) {
          set({ user, phase: 'needs_setup' })
        } else {
          const keys = await api().keys()
          set({ user, keys, phase: 'locked', lockReason: null })
        }
        startSocket()
      } catch {
        set({ phase: 'anon' })
      }
    },

    applyAuth: (r) => {
      wipe(get().vault)
      set({
        user: r.user,
        deviceId: r.device_id,
        keys: r.keys,
        vault: null,
        phase: r.keys_ready && r.keys ? 'locked' : 'needs_setup',
        lockReason: null,
        endedReason: null
      })
      startSocket()
    },

    refreshKeys: async () => {
      try {
        const keys = await api().keys()
        set({ keys })
        return keys
      } catch (e) {
        if (isApiError(e, 'keys_not_ready')) {
          wipe(get().vault)
          set({ keys: null, vault: null, phase: 'needs_setup' })
        }
        return null
      }
    },

    unlock: async (password) => {
      const { user, keys } = get()
      if (!user || !keys) throw new Error('Sessão sem chaves')
      const dek = await unlockWithPassword(user.id, keys, password, kekInWorker)
      await get().openVault(dek)
    },

    openVault: async (dek) => {
      const user = get().user
      if (!user) throw new Error('Sessão sem usuário')
      const own = new Uint8Array(dek)
      const sk = await deriveSubkeys(own)
      wipe(get().vault)
      set({
        vault: { dek: own, sk, repo: new Repo(api(), user.id, sk) },
        phase: 'unlocked',
        lockReason: null,
        lastActivity: Date.now()
      })
    },

    lock: (reason = 'manual') => {
      wipe(get().vault)
      set({ vault: null, phase: get().keys ? 'locked' : get().phase, lockReason: reason })
    },

    logout: async () => {
      try {
        await api().logout()
      } catch {
        /* sessão já pode ter acabado no servidor */
      }
      get().endSession(null)
    },

    endSession: (reason) => {
      stopSocket()
      wipe(get().vault)
      api().setToken(null)
      set({
        phase: 'anon',
        user: null,
        deviceId: null,
        keys: null,
        vault: null,
        lockReason: null,
        endedReason: reason
      })
    },

    touch: () => set({ lastActivity: Date.now() })
  }
})
