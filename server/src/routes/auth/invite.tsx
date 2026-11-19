import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useParams } from 'wouter'
import { Loading } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useInstance, useSession } from '@/hooks/auth'
import { rememberWorkspace } from '@/hooks/workspace'
import { authApi } from '@/lib/api/auth'
import { workspacesApi } from '@/lib/api/workspaces'
import { qk } from '@/lib/query'
import { cn } from '@/lib/utils'
import { AuthLayout, FormError } from './auth-layout'
import { useSubmit } from './fields'
import { InviteCard, useInvitePreview } from './invite-preview'
import { SsoButtons } from './sso-buttons'

export default function Invite() {
  const { token } = useParams<{ token: string }>()
  const preview = useInvitePreview(token)
  const session = useSession()
  const instance = useInstance().data
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const join = useSubmit()

  if (preview.isPending || session.isPending) {
    return (
      <AuthLayout title="Opening your invite">
        <Loading />
      </AuthLayout>
    )
  }
  if (preview.isError || !preview.data) {
    return (
      <AuthLayout
        title="This invite link doesn't work"
        description="It may have expired, been canceled, or already been used. Ask the person who invited you to send a new link."
      >
        <Link href="~/" className={buttonVariants({ size: 'lg' })}>
          Go to Print Better
        </Link>
      </AuthLayout>
    )
  }

  const invite = preview.data
  const user = session.data?.user
  const onJoin = () =>
    join.run(async () => {
      const workspace = await workspacesApi.acceptInvite(token)
      await qc.fetchQuery({ queryKey: qk.session, queryFn: authApi.session, staleTime: 0 })
      rememberWorkspace(workspace.id)
      navigate(`~/w/${workspace.id}`, { replace: true })
    })

  return (
    <AuthLayout title={`Join ${invite.workspaceName}`} description={user ? `You're signed in as ${user.name}.` : undefined}>
      <InviteCard {...invite} />
      {user ? (
        <div className="flex flex-col gap-4">
          <FormError message={join.error} />
          <Button size="lg" className="w-full" onClick={onJoin} disabled={join.pending}>
            {join.pending && <Spinner data-icon="inline-start" />}
            Join {invite.workspaceName}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Link href={`~/signup?invite=${encodeURIComponent(token)}`} className={cn(buttonVariants({ size: 'lg' }), 'w-full')}>
            Create an account
          </Link>
          <Link
            href={`~/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
          >
            I already have an account
          </Link>
          <SsoButtons providers={instance?.sso ?? []} invite={token} />
        </div>
      )}
    </AuthLayout>
  )
}
