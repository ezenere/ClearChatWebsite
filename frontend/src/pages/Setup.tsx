// /setup: conta sem chaves (keys_ready=false — usuário criado pelo admin, cadastro interrompido ou
// depois de "zerar criptografia") define a senha de criptografia (SYNC_PROTOCOL.md §5.1).
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { AuthLayout } from '../components/AuthLayout'
import { KeySetupFlow, type KeySetupStage } from '../components/KeySetupFlow'
import { FullPageSpinner } from '../components/ui'
import { useSession } from '../state/session'

export default function Setup() {
  const { phase, user } = useSession()
  const navigate = useNavigate()
  const [stage, setStage] = useState<KeySetupStage>('password')
  const [finished, setFinished] = useState(false)
  if (phase === 'boot') return <FullPageSpinner />
  if (phase === 'anon') return <Navigate to="/login?next=%2Fsetup" replace />
  if ((phase === 'locked' || phase === 'unlocked') && !finished)
    return <Navigate to="/app" replace />
  return (
    <AuthLayout
      wide
      step={{ current: stage === 'password' ? 1 : 2, total: 2 }}
      title={
        stage === 'password'
          ? 'Defina sua senha de criptografia'
          : 'Guarde sua chave de recuperação'
      }
      subtitle={
        stage === 'password' ? (
          <>
            Conta <b className="text-fg">{user?.email}</b> ainda não tem chaves. Crie a senha que
            vai cifrar seus dados.
          </>
        ) : (
          'Se você esquecer a senha, esta chave é a única forma de recuperar seus dados.'
        )
      }
    >
      <KeySetupFlow
        onStage={setStage}
        onDone={() => {
          setFinished(true)
          navigate('/app', { replace: true })
        }}
      />
    </AuthLayout>
  )
}
