import { isApiError } from '../api/client'
import { AuthError, RecoveryKeyError } from '../crypto'

/** Mensagem pt-BR para mostrar ao usuário. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === 'rate_limited' && e.retryAfter)
      return `Muitas tentativas. Tente de novo em ${Math.max(1, Math.ceil(e.retryAfter / 60))} min.`
    return e.message
  }
  if (e instanceof AuthError) return 'Senha incorreta.'
  if (e instanceof RecoveryKeyError) return 'Chave de recuperação incorreta. Confira a digitação.'
  if (e instanceof Error && /limites aceitos|kdf não suportado/.test(e.message))
    return 'O servidor enviou parâmetros de chave fora dos limites seguros. Por segurança, o desbloqueio foi interrompido.'
  return e instanceof Error ? e.message : 'Algo deu errado.'
}
