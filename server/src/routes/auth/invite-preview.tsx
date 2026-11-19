import { useQuery } from '@tanstack/react-query'
import { Building2 } from 'lucide-react'
import { workspacesApi } from '@/lib/api/workspaces'
import { date } from '@/lib/format'
import { ROLE_NAMES } from '@/lib/words'

export function useInvitePreview(token: string | null) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => workspacesApi.invitePreview(token!),
    enabled: !!token,
    retry: false,
  })
}

/** "Ana invited you to Home as a member", shown on the invite and sign-up screens. */
export function InviteCard({ workspaceName, inviterName, role, expiresAt }: {
  workspaceName: string
  inviterName: string | null
  role: keyof typeof ROLE_NAMES
  expiresAt: number
}) {
  const roleName = ROLE_NAMES[role].toLowerCase()
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-brand-container p-4 text-on-brand-container">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-background/60">
        <Building2 className="size-6" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-base">
          {inviterName ? `${inviterName} invited you to ` : 'You are invited to '}
          <strong className="font-semibold">{workspaceName}</strong> as {/^[aeiou]/.test(roleName) ? 'an' : 'a'} {roleName}.
        </p>
        <p className="text-sm opacity-80">The invite works until {date(expiresAt)}.</p>
      </div>
    </div>
  )
}
