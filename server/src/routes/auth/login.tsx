import { Fingerprint } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, Redirect, useSearchParams } from 'wouter'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { safeNext, useAfterSignIn, useInstance, useSession } from '@/hooks/auth'
import { authApi } from '@/lib/api/auth'
import { FullPageLoading } from '@/routes/guards'
import { AuthLayout, DocsLink, FormError, linkClass } from './auth-layout'
import { PasswordField, TextField, useSubmit } from './fields'
import { OrDivider, SsoButtons } from './sso-buttons'
import { usePasskeyLogin } from './use-passkey-login'

function LoginForm({ next, ssoError }: { next: string | null; ssoError: string | null }) {
  const instance = useInstance().data
  const afterSignIn = useAfterSignIn()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const submit = useSubmit()
  const passkey = usePasskeyLogin(() => afterSignIn(next))

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!login.trim() || !password) return submit.setError('Enter your username or email, and your password.')
    passkey.cancelAutofill()
    await submit.run(async () => {
      await authApi.login(login.trim(), password)
      await afterSignIn(next)
    })
  }

  const busy = submit.pending || passkey.pending
  const signupHref = next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'
  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to see your printers."
      footer={
        <>
          <Link href="/recover" className={linkClass}>
            Forgot your password?
          </Link>
          {instance?.signup === 'open' && (
            <span>
              New here?{' '}
              <Link href={signupHref} className={linkClass}>
                Create an account
              </Link>
            </span>
          )}
          <DocsLink />
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <TextField
          id="login"
          label="Username or email"
          autoComplete="username webauthn"
          autoCapitalize="none"
          spellCheck={false}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          required
          autoFocus
        />
        <PasswordField
          id="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <FormError message={submit.error ?? passkey.error ?? ssoError} />
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {submit.pending && <Spinner data-icon="inline-start" />}
          Sign in
        </Button>
      </form>
      {(passkey.supported || (instance?.sso.length ?? 0) > 0) && (
        <div className="flex flex-col gap-4">
          <OrDivider />
          {passkey.supported && (
            <Button variant="outline" size="lg" className="w-full" disabled={busy} onClick={() => passkey.signInNow(login.trim())}>
              {passkey.pending ? <Spinner data-icon="inline-start" /> : <Fingerprint data-icon="inline-start" />}
              Sign in with a passkey
            </Button>
          )}
          <SsoButtons providers={instance?.sso ?? []} next={next} />
        </div>
      )}
    </AuthLayout>
  )
}

export default function Login() {
  const [params] = useSearchParams()
  const next = params.get('next')
  const instance = useInstance()
  const session = useSession()
  if (instance.data?.setupRequired) return <Redirect to="~/setup" replace />
  if (session.isPending) return <FullPageLoading />
  if (session.data?.user) return <Redirect to={`~${safeNext(next)}`} replace />
  const ssoError = params.has('error')
    ? (params.get('message') ?? "Signing in with that account didn't work. Try again, or use your password.")
    : null
  return <LoginForm next={next} ssoError={ssoError} />
}
