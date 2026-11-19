import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Redirect, useLocation, useSearchParams } from 'wouter'
import { useInstance } from '@/hooks/auth'
import { rememberWorkspace } from '@/hooks/workspace'
import { authApi } from '@/lib/api/auth'
import { ApiError } from '@/lib/api/http'
import { qk } from '@/lib/query'
import { createPasskey, passkeyError } from '@/lib/webauthn'
import { FullPageLoading } from '@/routes/guards'
import { emptyAccount } from './account-fields'
import { AuthLayout, DocsLink } from './auth-layout'
import { useSubmit } from './fields'
import { AccountStep, StepIndicator, WelcomeStep, WorkspaceStep } from './setup-steps'

type Step = 'welcome' | 'account' | 'workspace'

const isTokenError = (e: unknown) => e instanceof ApiError && (e.status === 403 || /setup|token/i.test(e.code))

const TITLES: Record<Step, [string, string]> = {
  welcome: ['Welcome to Print Better', 'Print from anywhere to the printers you already have. Setup takes about two minutes.'],
  account: ['Create your account', 'You will be the owner of this server and can invite others later.'],
  workspace: ['Name the place your printers are', 'Most people start with Home or Office.'],
}

export default function Setup() {
  const instance = useInstance()
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const [params] = useSearchParams()
  const linkToken = params.get('token')
  const [step, setStep] = useState<Step>('welcome')
  const [draft, setDraft] = useState(emptyAccount)
  const [setupToken, setSetupToken] = useState(linkToken ?? '')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [workspaceName, setWorkspaceName] = useState('Home')
  // Once the account exists the instance reports setup as done; keep this screen until we finish.
  const [created, setCreated] = useState(false)
  const submit = useSubmit()

  if (instance.isPending) return <FullPageLoading />
  if (instance.data && !instance.data.setupRequired && !created) return <Redirect to="~/" replace />

  const finish = async () => {
    await qc.fetchQuery({ queryKey: qk.instance, queryFn: authApi.instance, staleTime: 0 })
    const session = await qc.fetchQuery({ queryKey: qk.session, queryFn: authApi.session, staleTime: 0 })
    const workspace = session.workspaces[0]
    if (workspace) rememberWorkspace(workspace.id)
    navigate(workspace ? `~/w/${workspace.id}/devices/add` : '~/welcome', { replace: true })
  }

  const create = () =>
    submit.run(async () => {
      const base = {
        setupToken: setupToken.trim(),
        username: draft.username.trim(),
        name: draft.name.trim(),
        workspaceName: workspaceName.trim(),
      }
      try {
        if (draft.method === 'password') {
          await authApi.setup({ ...base, password: draft.password })
        } else {
          const { challengeId, options } = await authApi.passkeySignupOptions(base)
          await authApi.passkeySignupVerify(challengeId, await createPasskey(options))
        }
      } catch (e) {
        if (e instanceof DOMException) {
          throw new Error(passkeyError(e) ?? 'The passkey was not saved. Try again, or go back and choose a password.')
        }
        if (isTokenError(e)) {
          setTokenError(e instanceof Error ? e.message : 'That setup code is not right.')
          setStep('account')
        }
        throw e
      }
      setCreated(true)
      await finish()
    })

  const [title, description] = TITLES[step]
  return (
    <AuthLayout
      title={title}
      description={description}
      aside={step === 'welcome' ? undefined : <StepIndicator current={step === 'workspace' ? 1 : 0} />}
      footer={<DocsLink />}
    >
      {step === 'welcome' && <WelcomeStep onNext={() => setStep('account')} />}
      {step === 'account' && (
        <AccountStep
          draft={draft}
          onChange={setDraft}
          setupToken={setupToken}
          onSetupToken={(value) => {
            setSetupToken(value)
            setTokenError(null)
          }}
          tokenError={tokenError}
          showToken={!linkToken || !!tokenError}
          onNext={() => setStep('workspace')}
        />
      )}
      {step === 'workspace' && (
        <WorkspaceStep
          name={workspaceName}
          onName={setWorkspaceName}
          pending={submit.pending}
          error={submit.error}
          passkey={draft.method === 'passkey'}
          onBack={() => setStep('account')}
          onSubmit={create}
        />
      )}
    </AuthLayout>
  )
}
