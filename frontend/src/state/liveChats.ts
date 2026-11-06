// Lista dos chats só ao vivo de outros dispositivos (§23.4), alimentada pelo WebSocket. Só memória: some
// ao sair da conta e ao fechar a aba. Os anúncios ficam cifrados aqui; quem decifra é a tela (com a DEK).
import { create } from 'zustand'
import {
  applyHost,
  applyList,
  applyRemoved,
  applyUpdate,
  dropStale,
  type LiveMap
} from '../data/liveChats'
import type { SyncEvent } from '../api/ws'

interface LiveChatsState {
  chats: LiveMap
  /** O servidor declarou suporte (welcome.caps com "live_chats") nesta conexão. */
  supported: boolean
  apply: (ev: SyncEvent) => void
  clear: () => void
}

let settleTimer: ReturnType<typeof setTimeout> | null = null

export const useLiveChats = create<LiveChatsState>((set, get) => ({
  chats: {},
  supported: false,
  apply: (ev) => {
    const cur = get().chats
    switch (ev.t) {
      case 'welcome':
        set({ supported: Array.isArray(ev.caps) && ev.caps.includes('live_chats') })
        break
      case 'live.list': {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = null
        set({ chats: applyList(cur, ev.chats, ev.settling_s) })
        if (ev.settling_s > 0)
          settleTimer = setTimeout(() => {
            settleTimer = null
            set({ chats: dropStale(get().chats) })
          }, ev.settling_s * 1000)
        break
      }
      case 'live.update':
        set({ chats: applyUpdate(cur, ev.chats) })
        break
      case 'live.removed':
        set({ chats: applyRemoved(cur, ev.host_device_id, ev.chat_ids) })
        break
      case 'live.host':
        set({ chats: applyHost(cur, ev.host_device_id, ev.status) })
        break
      default:
        break
    }
  },
  clear: () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
    set({ chats: {}, supported: false })
  }
}))
