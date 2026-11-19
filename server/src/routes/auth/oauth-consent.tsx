import { useQuery } from '@tanstack/react-query'
import { Bot, Check } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'wouter'
import { OptionCards } from '@/components/option-cards'
import { Mono } from '@/components/page'
import { Loading } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useUser } from '@/hooks/auth'
import { oauthApi } from '@/lib/api/admin'
import type { OAuthRequestInfo } from '@/lib/api/types'
import { AuthLayout, FormError } from './auth-layout'
import { useSubmit } from './fields'

const SCOPE_WORDS: Record<string, string> = {
  read: 'See your printers, devices and print jobs',
  print: 'Print documents on your printers',
  write: 'Change settings, devices and people',
}

function scopeLines(scopes: string[]) {
  const known = [...new Set(scopes.map((s) => SCOPE_WORDS[s]).filter(Boolean))]
  const unknown = scopes.filter((s) => !SCOPE_WORDS[s])
  return { known: known.length ? known : [SCOPE_WORDS.read, SCOPE_WORDS.print, SCOPE_WORDS.write], unknown }
}

function ClientBadge({ client }: { client: OAuthRequestInfo['client'] }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border bg-surface p-4">
      {client.logoUri ? (
        <img src={client.logoUri} alt="" className="size-12 shrink-0 rounded-2xl object-contain" />
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand-container text-on-brand-container">
          <Bot className="size-6" />
        </span>
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-lg font-semibold">{client.name}</span>
        {client.uri && <Mono className="truncate text-sm text-muted-foreground">{client.uri.replace(/^https?:\/\//, '')}</Mono>}
      </div>
    </div>
  )
}

function Consent({ id, info }: { id: string; info: OAuthRequestInfo }) {
  const user = useUser()
  const [ws, setWs] = useState<string>(info.workspaces.length === 1 ? info.workspaces[0].id : 'all')
  const allow = useSubmit()
  const deny = useSubmit()
  const { known, unknown } = scopeLines(info.scopes)
  const busy = allow.pending || deny.pending

  const finish = (action: () => Promise<{ redirectTo: string }>, submit: typeof allow) =>
    submit.run(async () => {
      const { redirectTo } = await action()
      window.location.assign(redirectTo)
    })

  return (
    <>
      <ClientBadge client={info.client} />
      <div className="flex flex-col gap-3">
        <h2 className="text-[0.9375rem] font-medium">It will be able to</h2>
        <ul className="flex flex-col gap-2">
          {known.map((line) => (
            <li key={line} className="flex items-start gap-3 text-base">
              <Check className="mt-0.5 size-5 shrink-0 text-ok" />
              {line}
            </li>
          ))}
          {unknown.map((scope) => (
            <li key={scope} className="flex items-start gap-3 text-base">
              <Check className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <Mono>{scope}</Mono>
            </li>
          ))}
        </ul>
      </div>
      {info.workspaces.length > 1 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-[0.9375rem] font-medium">Which workspace can it use?</legend>
          <OptionCards
            label="Workspace"
            layout="inline"
            columns={2}
            value={ws}
            onChange={setWs}
            options={[{ value: 'all', label: 'All my workspaces' }, ...info.workspaces.map((w) => ({ value: w.id, label: w.name }))]}
          />
        </fieldset>
      )}
      <FormError message={allow.error ?? deny.error} />
      <div className="flex flex-col gap-3">
        <Button size="lg" className="w-full" disabled={busy} onClick={() => finish(() => oauthApi.approve(id, ws === 'all' ? null : ws), allow)}>
          {allow.pending && <Spinner data-icon="inline-start" />}
          Allow
        </Button>
        <Button variant="outline" size="lg" className="w-full" disabled={busy} onClick={() => finish(() => oauthApi.deny(id), deny)}>
          {deny.pending && <Spinner data-icon="inline-start" />}
          Don't allow
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Signed in as {user?.name}. After you choose, you'll go back to <Mono>{info.redirectHost}</Mono>. You can remove this access any
        time in Your account, under Apps and tokens.
      </p>
    </>
  )
}

export default function OAuthConsent() {
  const [params] = useSearchParams()
  const id = params.get('request')
  const request = useQuery({ queryKey: ['oauth-request', id], queryFn: () => oauthApi.request(id!), enabled: !!id, retry: false })

  if (!id) {
    return (
      <AuthLayout title="This sign-in link is incomplete" description="Go back to the app that sent you here and start connecting again." />
    )
  }
  if (request.isPending) {
    return (
      <AuthLayout title="Allow access">
        <Loading />
      </AuthLayout>
    )
  }
  if (request.isError || !request.data) {
    return (
      <AuthLayout
        title="This request has expired"
        description="Connection requests last 10 minutes. Go back to the app and start connecting again."
      />
    )
  }
  return (
    <AuthLayout title={`Allow ${request.data.client.name} to use Print Better?`}>
      <Consent id={id} info={request.data} />
    </AuthLayout>
  )
}
