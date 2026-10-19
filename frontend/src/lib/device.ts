// Dados do "dispositivo" que o site registra no login (client: web, can_host: false).
import type { DeviceInput } from '../api/types'
import { SITE_VERSION } from '../api/config'

export function browserLabel(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Navegador'
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} no ${os}` : browser
}

export function webDevice(): DeviceInput {
  return {
    name: `Site — ${browserLabel()}`.slice(0, 64),
    platform: 'web',
    client: 'web',
    app_version: SITE_VERSION,
    can_host: false
  }
}
