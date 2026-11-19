import { AppWindow, KeyRound } from 'lucide-react'
import { Link } from 'wouter'
import type { ApiToken } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useDeleteToken, useTokens } from '@/hooks/account'
import { useSession } from '@/hooks/auth'
import { date, timeAgo } from '@/lib/format'
import { CreateTokenDialog } from './create-token-dialog'

function TokenRow({ token, workspaceName }: { token: ApiToken; workspaceName: string }) {
  const remove = useDeleteToken()
  const Icon = token.kind === 'oauth' ? AppWindow : KeyRound
  const expired = token.expiresAt !== null && token.expiresAt < Date.now()
  const details = [
    workspaceName,
    token.lastUsedAt ? `last used ${timeAgo(token.lastUsedAt)}` : 'not used yet',
    token.expiresAt ? `${expired ? 'expired' : 'expires'} ${date(token.expiresAt)}` : 'never expires',
  ]
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted">
          <Icon className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[0.9375rem] font-medium">{token.name}</span>
          <span className="text-sm text-muted-foreground">{details.join(', ')}</span>
        </div>
      </div>
      <Confirm
        trigger={<Button variant="ghost" size="sm" className="self-start sm:self-auto">{token.kind === 'oauth' ? 'Disconnect' : 'Remove'}</Button>}
        title={token.kind === 'oauth' ? `Disconnect ${token.name}?` : `Remove “${token.name}”?`}
        description="Anything using it stops working right away. You can connect or create a new one later."
        confirmLabel={token.kind === 'oauth' ? 'Disconnect' : 'Remove token'}
        destructive
        onConfirm={() => remove.mutateAsync(token.id)}
      />
    </li>
  )
}

function TokenList({ tokens, empty }: { tokens: ApiToken[]; empty: string }) {
  const workspaces = useSession().data?.workspaces ?? []
  const nameOf = (id: string | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? 'One workspace') : 'All workspaces')
  if (tokens.length === 0) return <p className="px-5 py-5 text-[0.9375rem] text-muted-foreground sm:px-6">{empty}</p>
  return (
    <ul>
      {tokens.map((t) => (
        <TokenRow key={t.id} token={t} workspaceName={nameOf(t.workspaceId)} />
      ))}
    </ul>
  )
}

export function TokensTab() {
  const tokens = useTokens()
  return (
    <div className="flex flex-col gap-10">
      <Section
        id="apps"
        title="Connected apps"
        description="AI assistants and other apps you allowed to use Print Better for you."
        flush
      >
        <QueryState query={tokens}>
          {(list) => (
            <TokenList
              tokens={list.filter((t) => t.kind === 'oauth')}
              empty="No apps connected yet. Connect AI shows how to add one."
            />
          )}
        </QueryState>
      </Section>
      <Section
        id="tokens"
        title="Personal API tokens"
        description="For scripts and tools that send a token instead of signing in."
        actions={<CreateTokenDialog />}
        flush
      >
        <QueryState query={tokens}>
          {(list) => <TokenList tokens={list.filter((t) => t.kind === 'pat')} empty="No tokens yet." />}
        </QueryState>
      </Section>
      <p className="px-1 text-sm text-muted-foreground">
        Want an AI assistant to manage your printers?{' '}
        <Link href="~/connect" className="font-medium text-foreground underline underline-offset-4">
          See how to connect one
        </Link>
        .
      </p>
    </div>
  )
}
