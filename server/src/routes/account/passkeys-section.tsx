import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { Passkey } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { useDeletePasskey, usePasskeys } from '@/hooks/account'
import { authApi } from '@/lib/api/auth'
import { date, timeAgo } from '@/lib/format'
import { qk } from '@/lib/query'
import { createPasskey, passkeyError, passkeysSupported } from '@/lib/webauthn'
import { RenameDialog } from './rename-dialog'
import { thisDeviceName } from './user-agent'

function useAddPasskey() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const { challengeId, options } = await authApi.passkeyRegisterOptions()
      const credential = await createPasskey(options)
      await authApi.passkeyRegisterVerify(challengeId, credential, thisDeviceName())
      await qc.invalidateQueries({ queryKey: qk.passkeys })
      toast.success('Passkey added')
    } catch (e) {
      setError(passkeyError(e))
    } finally {
      setBusy(false)
    }
  }
  return { add, busy, error }
}

function PasskeyRow({ passkey }: { passkey: Passkey }) {
  const remove = useDeletePasskey()
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted">
          <KeyRound className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[0.9375rem] font-medium">{passkey.name}</span>
          <span className="text-sm text-muted-foreground">
            {passkey.backedUp ? 'Synced across your devices' : 'Saved on one device'}, added {date(passkey.createdAt)}
            {passkey.lastUsedAt ? `, last used ${timeAgo(passkey.lastUsedAt)}` : ', not used yet'}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <RenameDialog passkey={passkey} />
        <Confirm
          trigger={<Button variant="ghost" size="sm">Remove</Button>}
          title={`Remove “${passkey.name}”?`}
          description="You won’t be able to sign in with this passkey anymore. You can’t remove your only way to sign in."
          confirmLabel="Remove passkey"
          destructive
          onConfirm={() => remove.mutateAsync(passkey.id)}
        />
      </div>
    </li>
  )
}

export function PasskeysSection() {
  const passkeys = usePasskeys()
  const { add, busy, error } = useAddPasskey()
  const supported = passkeysSupported()
  return (
    <Section
      id="passkeys"
      title="Passkeys"
      description="Sign in with your fingerprint, face or device PIN instead of a password."
      actions={
        supported && (
          <Button variant="outline" onClick={add} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
            Add a passkey
          </Button>
        )
      }
      flush
    >
      {!supported && <p className="border-b px-5 py-4 text-[0.9375rem] text-muted-foreground sm:px-6">This browser can’t create passkeys.</p>}
      {error && <FieldError className="border-b px-5 py-4 sm:px-6">{error}</FieldError>}
      <QueryState query={passkeys}>
        {(list) =>
          list.length === 0 ? (
            <p className="px-5 py-5 text-[0.9375rem] text-muted-foreground sm:px-6">
              No passkeys yet. Add one to sign in without typing a password.
            </p>
          ) : (
            <ul>
              {list.map((p) => (
                <PasskeyRow key={p.id} passkey={p} />
              ))}
            </ul>
          )
        }
      </QueryState>
    </Section>
  )
}
