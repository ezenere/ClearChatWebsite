// Tipos da API REST/WebSocket (SYNC_PROTOCOL.md §6, §7, §10). Só o que o site usa.
import type { Envelope, KeysResponse, KeysSetupBody, PasswordSlot, RecoverySlot } from '../crypto'

export type { Envelope, KeysResponse, KeysSetupBody, PasswordSlot, RecoverySlot }

export interface InstanceInfo {
  name: string
  server_version: string
  base_url: string
  protocol: { min: number; max: number; version: string }
  features: {
    signupOpen: boolean
    captcha: { provider: 'turnstile'; siteKey: string } | null
    landing: boolean
    gateway: boolean
  }
  links: { download?: string; signup?: string }
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

export interface DeviceInput {
  name: string
  platform: string
  client: 'desktop' | 'mobile' | 'web'
  app_version: string
  can_host: boolean
}

export interface Tokens {
  access_token: string
  access_expires_in: number
  refresh_token?: string
  refresh_expires_in: number
}

export interface User {
  id: string
  email: string
  name: string
}

export interface AuthResult extends Tokens {
  user: User
  device_id: string
  keys_ready: boolean
  keys: KeysResponse | null
}

export interface Account {
  id: string
  email: string
  name: string
  created_at: string
  keys_ready: boolean
  usage: {
    record_bytes: number
    records: number
    blob_bytes: number
    blobs: number
    devices: number
  }
  quotas: {
    record_bytes: number | null
    records: number | null
    blob_bytes: number | null
    devices: number | null
  }
}

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  client: string
  app_version: string
  can_host: boolean
  created_at: string
  last_seen_at: string | null
  last_ip: string | null
  online: boolean
  current: boolean
}

export interface Change {
  seq: number
  type: string
  id: string
  scope: string | null
  rev: number
  deleted: boolean
  env?: Envelope
  omitted?: true
  size: number
  blobs: string[]
  device_id: string
  updated_at: string
}

/**
 * Resposta de `GET /records`. O contrato (§6.7) não fixa o formato; assumimos o mesmo padrão do feed
 * (§7.3): `records` + `next` (maior seq devolvido) + `has_more` (+ `head`, opcional).
 */
export interface RecordsPage {
  records: Change[]
  next: number
  has_more: boolean
  head?: number
}

export interface PushItem {
  type: string
  id: string
  scope: string | null
  base_rev: number
  rev: number
  deleted: boolean
  env?: Envelope
  blobs: string[]
}

export interface PushRequest {
  push_id: string
  items: PushItem[]
  chat_bases?: Record<string, number>
  host_epochs?: Record<string, number>
}

export interface PushResponse {
  results: { type: string; id: string; rev: number; seq: number }[]
  head: number
  chat_heads?: Record<string, number>
}

export interface PushConflict {
  type: string
  id: string
  reason: 'rev_mismatch' | 'gone' | 'scope_deleted' | 'scope_missing'
  current?: Change
}
