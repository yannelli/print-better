import { type FormEvent, useState } from 'react'
import { Link } from 'wouter'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAfterSignIn } from '@/hooks/auth'
import { authApi } from '@/lib/api/auth'
import { AuthLayout, FormError } from './auth-layout'
import { MIN_PASSWORD, PasswordField, passwordProblem, useSubmit } from './fields'

export default function Reset() {
  // The token travels in the fragment so it never reaches server logs or Referer headers.
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token'))
  const afterSignIn = useAfterSignIn()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [attempted, setAttempted] = useState(false)
  const submit = useSubmit()

  if (!token) {
    return (
      <AuthLayout title="This reset link is incomplete" description="Open the link from your email again, or start over to get a new one.">
        <Link href="/recover" className={buttonVariants({ size: 'lg' })}>
          Start over
        </Link>
      </AuthLayout>
    )
  }

  const tooShort = attempted ? passwordProblem(password) : null
  const mismatch = attempted && !tooShort && password !== confirm ? "The two passwords don't match." : null

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    if (passwordProblem(password, confirm)) return
    await submit.run(async () => {
      await authApi.resetConfirm(token, password)
      await afterSignIn()
    })
  }

  return (
    <AuthLayout title="Choose a new password" description="You'll be signed in right after. Use the new password on your other devices too.">
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <PasswordField
          id="reset-password"
          label="New password"
          description={`At least ${MIN_PASSWORD} characters.`}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={tooShort}
          required
          autoFocus
        />
        <PasswordField
          id="reset-confirm"
          label="Type it again"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch}
          required
        />
        <FormError message={submit.error} />
        <Button type="submit" size="lg" className="w-full" disabled={submit.pending}>
          {submit.pending && <Spinner data-icon="inline-start" />}
          Change password
        </Button>
      </form>
    </AuthLayout>
  )
}
