import { Link } from 'react-router'
import { AppIcon } from '../components/Logo'

export default function NotFound() {
  return (
    <div className="glow flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <AppIcon className="mb-5 size-12" />
      <p className="font-mono text-sm text-subtle">404</p>
      <h1 className="mt-1 text-xl font-semibold">Página não encontrada</h1>
      <Link to="/" className="mt-6 text-sm text-accent-strong hover:underline">
        Voltar ao início
      </Link>
    </div>
  )
}
