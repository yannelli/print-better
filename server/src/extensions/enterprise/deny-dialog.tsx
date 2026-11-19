import { type FormEvent, useId, useState } from 'react'
import type { Job } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useDeny } from './hooks'

/** Deny needs a reason: the sender sees "Not approved: reason". */
export function DenyDialog({ ws, job, open, onOpenChange }: { ws: string; job: Job; open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const deny = useDeny(ws)
  const [reason, setReason] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    deny.mutate({ id: job.id, reason: reason.trim() }, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Don’t print “{job.title}”?</DialogTitle>
            <DialogDescription>The job is canceled. The person who sent it sees your reason.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
            <Textarea
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={500}
              placeholder="Please print this on the copier downstairs"
              autoFocus
            />
            <FieldDescription>Shown as “Not approved: {reason.trim() || 'your reason'}”.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep waiting
            </Button>
            <Button type="submit" variant="destructive" disabled={!reason.trim() || deny.isPending}>
              {deny.isPending && <Spinner data-icon="inline-start" />}
              Deny
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
