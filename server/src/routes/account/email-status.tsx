import { useEffect, useState } from 'react'
import { Row } from '@/components/page'
import { StatusPill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { useSendVerification } from '@/hooks/account'
import { useInstance } from '@/hooks/auth'
import { ApiError, errorMessage } from '@/lib/api/http'

const COOLDOWN_SECONDS = 60

function useCountdown() {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  return [left, () => setLeft(COOLDOWN_SECONDS)] as const
}

function statusText(verified: boolean, emailEnabled: boolean) {
  if (verified) return 'We’ve confirmed this address is yours.'
  if (!emailEnabled) return 'This server can’t send email yet, so this address can’t be confirmed. Ask your server admin to set up email.'
  return 'Confirm it’s yours with the link we email you. The link works for 24 hours.'
}

/** The saved address with its verification state, and a way to (re)send the link when the server can email. */
export function EmailStatusRow({ email, verified }: { email: string; verified: boolean }) {
  const emailEnabled = useInstance().data?.emailEnabled ?? false
  const send = useSendVerification()
  const [left, startCooldown] = useCountdown()
  const [sentTo, setSentTo] = useState<string | null>(null)
  const canSend = !verified && emailEnabled

  const onSend = () =>
    send.mutate(undefined, {
      onSuccess: () => {
        setSentTo(email)
        startCooldown()
      },
      onError: (e) => {
        if (e instanceof ApiError && e.status === 429) startCooldown()
      },
    })

  const label = left > 0 ? `Resend in ${left}s` : sentTo === email ? 'Resend' : 'Send verification email'
  return (
    <Row
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-all">{email}</span>
          <StatusPill status={verified ? { label: 'Verified', tone: 'ok' } : { label: 'Not verified', tone: 'warn' }} />
        </span>
      }
      description={
        <span className="flex flex-col gap-1">
          {statusText(verified, emailEnabled)}
          {canSend && sentTo === email && !send.isError && (
            <span role="status" className="text-foreground">
              Sent to {email}. Check your inbox, and your spam folder if it isn’t there in a few minutes.
            </span>
          )}
          {canSend && send.isError && <FieldError>{errorMessage(send.error)}</FieldError>}
        </span>
      }
    >
      {canSend && (
        <Button variant="outline" onClick={onSend} disabled={send.isPending || left > 0}>
          {send.isPending && <Spinner data-icon="inline-start" />}
          {label}
        </Button>
      )}
    </Row>
  )
}
