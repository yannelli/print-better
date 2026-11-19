import { type FormEvent, useState } from 'react'
import { Link, Redirect, useSearchParams } from 'wouter'
import { Loading } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { safeNext, useAfterSignIn, useInstance, useSession } from '@/hooks/auth'
import { authApi } from '@/lib/api/auth'
import { meApi } from '@/lib/api/me'
import { createPasskey } from '@/lib/webauthn'
import { FullPageLoading } from '@/routes/guards'
import { AccountFields, accountErrors, emptyAccount } from './account-fields'
import { AuthLayout, DocsLink, FormError, linkClass } from './auth-layout'
import { useSubmit } from './fields'
import { InviteCard, useInvitePreview } from './invite-preview'
import { OrDivider, SsoButtons } from './sso-buttons'

function SignupForm({ invite, next, onStart }: { invite: string | null; next: string | null; onStart: () => void }) {
  const instance = useInstance().data
  const preview = useInvitePreview(invite)
  const afterSignIn = useAfterSignIn()
  const [draft, setDraft] = useState(emptyAccount)
  const [attempted, setAttempted] = useState(false)
  const submit = useSubmit()
  const errors = attempted ? accountErrors(draft, { email: true }) : {}
  const loginHref = `/login${next ? `?next=${encodeURIComponent(next)}` : ''}`

  if (invite && preview.isPending) return <AuthLayout title="Create your account"><Loading /></AuthLayout>
  if (invite && preview.isError) {
    return (
      <AuthLayout title="This invite link doesn't work" description="It may have expired or already been used. Ask the person who invited you for a new link.">
        <Link href="/login" className={buttonVariants({ size: 'lg' })}>Go to sign in</Link>
      </AuthLayout>
    )
  }
  if (!invite && instance?.signup !== 'open') {
    return (
      <AuthLayout
        title="You need an invite"
        description="New accounts on this server are by invitation. Ask someone who already uses it to send you an invite link, then open that link."
        footer={<DocsLink />}
      >
        <Link href={loginHref} className={buttonVariants({ size: 'lg' })}>I already have an account</Link>
      </AuthLayout>
    )
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    if (Object.keys(accountErrors(draft, { email: true })).length) return
    const base = { username: draft.username.trim(), name: draft.name.trim(), inviteToken: invite ?? undefined }
    const email = draft.email.trim() || undefined
    onStart()
    void submit.run(async () => {
      if (draft.method === 'password') {
        await authApi.register({ ...base, email, password: draft.password })
      } else {
        const { challengeId, options } = await authApi.passkeySignupOptions(base)
        await authApi.passkeySignupVerify(challengeId, await createPasskey(options))
        if (email) await meApi.update({ email }).catch(() => undefined)
      }
      await afterSignIn(next)
    })
  }

  return (
    <AuthLayout
      title="Create your account"
      description={invite ? undefined : 'It takes a minute. You can change any of this later.'}
      footer={
        <>
          <span>
            Already have an account?{' '}
            <Link href={invite ? `/login?next=${encodeURIComponent(`/invite/${invite}`)}` : loginHref} className={linkClass}>
              Sign in
            </Link>
          </span>
          <DocsLink />
        </>
      }
    >
      {preview.data && <InviteCard {...preview.data} />}
      <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        <AccountFields draft={draft} onChange={setDraft} errors={errors} showEmail />
        <FormError message={submit.error} />
        <Button type="submit" size="lg" className="w-full" disabled={submit.pending}>
          {submit.pending && <Spinner data-icon="inline-start" />}
          {draft.method === 'passkey' ? 'Create account with a passkey' : 'Create account'}
        </Button>
      </form>
      {(instance?.sso.length ?? 0) > 0 && (
        <div className="flex flex-col gap-4">
          <OrDivider />
          <SsoButtons providers={instance?.sso ?? []} next={next} invite={invite} />
        </div>
      )}
    </AuthLayout>
  )
}

export default function Signup() {
  const [params] = useSearchParams()
  const invite = params.get('invite')
  const next = params.get('next')
  const instance = useInstance()
  const session = useSession()
  // Once this screen creates the account, useAfterSignIn decides where to go, not the redirect below.
  const [signingUp, setSigningUp] = useState(false)
  if (instance.data?.setupRequired) return <Redirect to="~/setup" replace />
  if (session.isPending || instance.isPending) return <FullPageLoading />
  if (session.data?.user && !signingUp) return <Redirect to={invite ? `~/invite/${invite}` : `~${safeNext(next)}`} replace />
  return <SignupForm invite={invite} next={next} onStart={() => setSigningUp(true)} />
}
