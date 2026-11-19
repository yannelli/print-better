import { MailCheck } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link } from 'wouter'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAfterSignIn, useInstance } from '@/hooks/auth'
import { authApi } from '@/lib/api/auth'
import { AuthLayout, FormError, linkClass } from './auth-layout'
import { PasswordField, passwordProblem, TextField, useSubmit } from './fields'

function EmailReset() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const submit = useSubmit()
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (await submit.run(() => authApi.resetRequest(email.trim()))) setSent(true)
  }
  if (sent) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-2xl bg-ok-container p-4 text-on-ok-container">
        <MailCheck className="mt-0.5 size-5 shrink-0" />
        <p>If that address belongs to an account, a reset link is on its way. Check your inbox and spam folder.</p>
      </div>
    )
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <h2 className="text-lg font-semibold tracking-tight">Email me a reset link</h2>
      <TextField id="reset-email" type="email" label="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <FormError message={submit.error} />
      <Button type="submit" variant="outline" size="lg" className="w-full" disabled={submit.pending || !email.includes('@')}>
        {submit.pending && <Spinner data-icon="inline-start" />}
        Send reset link
      </Button>
    </form>
  )
}

function CodeRecovery() {
  const afterSignIn = useAfterSignIn()
  const [login, setLogin] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [attempted, setAttempted] = useState(false)
  const submit = useSubmit()
  const passwordError = attempted && password ? passwordProblem(password) : null

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    if (!login.trim() || !code.trim() || (password && passwordProblem(password))) return
    void submit.run(async () => {
      await authApi.recover({ login: login.trim(), code: code.trim(), newPassword: password || undefined })
      await afterSignIn('/account/security')
    })
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <TextField
        id="recover-login"
        label="Username or email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        error={attempted && !login.trim() ? 'Enter your username or email.' : null}
        required
        autoFocus
      />
      <TextField
        id="recover-code"
        label="Recovery code"
        description="One of the codes you saved when you set up your account. Each code works once."
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        error={attempted && !code.trim() ? 'Enter a recovery code.' : null}
        required
      />
      <PasswordField
        id="recover-password"
        label="New password (optional)"
        description="Leave empty to keep your current password."
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={passwordError}
      />
      <FormError message={submit.error} />
      <Button type="submit" size="lg" className="w-full" disabled={submit.pending}>
        {submit.pending && <Spinner data-icon="inline-start" />}
        Sign in with recovery code
      </Button>
    </form>
  )
}

export default function Recover() {
  const emailEnabled = useInstance().data?.emailEnabled ?? false
  return (
    <AuthLayout
      title="Get back into your account"
      description="Use a recovery code to sign in. If you don't have one, ask the person who runs this server to reset your password."
      footer={
        <Link href="/login" className={linkClass}>
          Back to sign in
        </Link>
      }
    >
      <CodeRecovery />
      {emailEnabled && (
        <div className="flex flex-col gap-6 border-t pt-6">
          <EmailReset />
        </div>
      )}
    </AuthLayout>
  )
}
