import { KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'wouter'
import type { Identity, IdentityList, SsoProviderId } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { useIdentities, useUnlinkIdentity } from '@/hooks/account'
import { ssoLinkUrl } from '@/lib/api/auth'
import { date } from '@/lib/format'
import { FormError } from '../auth/auth-layout'
import { GoogleMark } from '../auth/sso-buttons'

const HERE = '/account/security'

interface ProviderRow {
  provider: SsoProviderId
  providerName: string
  linked: Identity | null
  /** False when the admin turned this provider off after it was connected. */
  enabled: boolean
}

function providerRows({ identities, available }: IdentityList): ProviderRow[] {
  const rows: ProviderRow[] = available.map((a) => ({ ...a, linked: identities.find((i) => i.provider === a.provider) ?? null, enabled: true }))
  for (const i of identities) {
    if (!rows.some((r) => r.provider === i.provider)) rows.push({ provider: i.provider, providerName: i.providerName, linked: i, enabled: false })
  }
  return rows
}

/** Reads the `?error=&message=` a failed connect redirects back with, then drops it from the address bar. */
function useConnectError(): string | null {
  const [params, setParams] = useSearchParams()
  const [message] = useState(() =>
    params.has('error') ? (params.get('message') ?? 'Connecting that account didn’t work. Try again.') : null,
  )
  useEffect(() => {
    if (message) setParams({}, { replace: true })
  }, [message, setParams])
  return message
}

function ProviderItem({ row }: { row: ProviderRow }) {
  const unlink = useUnlinkIdentity()
  const { provider, providerName, linked } = row
  const status = linked
    ? `${linked.email ? `Connected as ${linked.email}` : 'Connected'} since ${date(linked.createdAt)}`
    : 'Not connected'
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted">
          {provider === 'google' ? <GoogleMark /> : <KeyRound className="size-5" />}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[0.9375rem] font-medium">{providerName}</span>
          <span className="text-sm break-all text-muted-foreground">
            {status}
            {!row.enabled && '. Signing in this way is turned off on this server.'}
          </span>
        </div>
      </div>
      {linked ? (
        <Confirm
          trigger={<Button variant="ghost" size="sm">Disconnect</Button>}
          title={`Disconnect ${providerName}?`}
          description={`You won’t be able to sign in with this ${providerName} account anymore. You can connect it again later.`}
          confirmLabel="Disconnect"
          destructive
          onConfirm={() => unlink.mutateAsync(provider)}
        />
      ) : (
        <a href={ssoLinkUrl(provider, HERE)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Connect
        </a>
      )}
    </li>
  )
}

export function ConnectedAccountsSection() {
  const identities = useIdentities()
  const error = useConnectError()
  const alertRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error) alertRef.current?.scrollIntoView({ block: 'center' })
  }, [error])

  const nothingToShow = identities.data?.available.length === 0 && identities.data.identities.length === 0
  if (nothingToShow && !error) return null
  return (
    <Section
      id="connected"
      title="Connected accounts"
      description="Sign in with an account you already have. Connecting one also gives you a backup way in."
      flush
    >
      {error && (
        <div ref={alertRef} className="border-b px-5 py-4 sm:px-6">
          <FormError message={error} />
        </div>
      )}
      <QueryState query={identities}>
        {(data) => (
          <ul>
            {providerRows(data).map((row) => (
              <ProviderItem key={row.provider} row={row} />
            ))}
          </ul>
        )}
      </QueryState>
    </Section>
  )
}
