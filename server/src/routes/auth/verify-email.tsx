import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import { buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useUser } from '@/hooks/auth'
import { authApi } from '@/lib/api/auth'
import { errorMessage } from '@/lib/api/http'
import type { SessionState } from '@/lib/api/types'
import { qk } from '@/lib/query'
import { AuthLayout, FormError } from './auth-layout'

type Outcome = { state: 'checking' } | { state: 'verified' } | { state: 'failed'; message: string }

function useVerifyEmail(token: string | null): Outcome {
  const qc = useQueryClient()
  const [outcome, setOutcome] = useState<Outcome>({ state: 'checking' })
  const started = useRef(false)
  useEffect(() => {
    // Links work once, so StrictMode's repeated effect must not post the token a second time.
    if (!token || started.current) return
    started.current = true
    authApi.verifyEmail(token).then(
      ({ user }) => {
        if (user) qc.setQueryData<SessionState>(qk.session, (s) => s && { ...s, user })
        setOutcome({ state: 'verified' })
      },
      (e: unknown) => setOutcome({ state: 'failed', message: errorMessage(e) }),
    )
  }, [token, qc])
  return outcome
}

export default function VerifyEmail() {
  // The token travels in the fragment so it never reaches server logs or Referer headers.
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token'))
  const outcome = useVerifyEmail(token)
  const signedIn = useUser() !== null
  const back = (
    <Link href={signedIn ? '/account' : '/login'} className={buttonVariants({ size: 'lg' })}>
      {signedIn ? 'Go to your account' : 'Sign in'}
    </Link>
  )

  if (!token) {
    return (
      <AuthLayout title="This link is incomplete" description="Open the link from your email again. If it still doesn’t work, send a new one from your profile.">
        {back}
      </AuthLayout>
    )
  }
  if (outcome.state === 'checking') {
    return (
      <AuthLayout title="Checking your link" description="This only takes a moment.">
        <div className="flex justify-center py-2">
          <Spinner className="size-6" aria-label="Checking your link" />
        </div>
      </AuthLayout>
    )
  }
  if (outcome.state === 'verified') {
    return (
      <AuthLayout title="Your email is verified" description="Thanks for confirming your address. You’re all set.">
        {back}
      </AuthLayout>
    )
  }
  return (
    <AuthLayout
      title="This link didn’t work"
      description="Links work once and expire after 24 hours, and stop working if you change your email address. You can send a new one from your profile."
    >
      <FormError message={outcome.message} />
      {back}
    </AuthLayout>
  )
}
