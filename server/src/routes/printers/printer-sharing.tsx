import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import type { Printer } from '@shared/types'
import { Mono, Row, Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Slot } from '@/extensions/slot'
import { useUpdatePrinter } from '@/hooks/printers'
import type { PrinterPatch } from '@/lib/api/printers'

const ALIAS = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

export function PrinterSharing({ ws, printer, canManage }: { ws: string; printer: Printer; canManage: boolean }) {
  const id = useId()
  const update = useUpdatePrinter(ws)
  const email = printer.settings.email
  const [alias, setAlias] = useState(email.alias ?? '')
  const aliasInvalid = alias !== '' && !ALIAS.test(alias)

  const patch = (settings: PrinterPatch['settings'], success: string) =>
    update.mutate({ id: printer.id, patch: { settings } }, { onSuccess: () => toast.success(success) })

  const saveAlias = (e: FormEvent) => {
    e.preventDefault()
    if (aliasInvalid) return
    patch({ email: { alias: alias || null } }, 'Email name saved')
  }

  return (
    <Section title="Sharing" id="sharing" flush>
      <Row
        label="Share on the local network"
        htmlFor={`${id}-lan`}
        description={`Phones and computers on the same Wi-Fi as ${printer.clientName} can print to it directly, without Print Better. Sharing must also be on for that device.`}
      >
        <Switch
          id={`${id}-lan`}
          checked={printer.settings.lanShare}
          disabled={!canManage || update.isPending}
          onCheckedChange={(on) => patch({ lanShare: on }, on ? 'Sharing on the local network' : 'No longer shared on the local network')}
        />
      </Row>
      <Slot name="printerSharingNote" props={{ ws, printer }} />
      <Row
        label="Print by email"
        htmlFor={`${id}-email`}
        description="Members can email a document to this printer's address to print it. The full address depends on the email domain your server admin set up."
      >
        <Switch
          id={`${id}-email`}
          checked={email.enabled}
          disabled={!canManage || update.isPending}
          onCheckedChange={(on) => patch({ email: { enabled: on } }, on ? 'Print by email turned on' : 'Print by email turned off')}
        />
      </Row>
      {email.enabled && (
        <form onSubmit={saveAlias} className="flex flex-col gap-3 border-t px-5 py-4 sm:px-6">
          <label htmlFor={`${id}-alias`} className="text-[0.9375rem] font-medium">
            Email name for this printer
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`${id}-alias`}
              value={alias}
              onChange={(e) => setAlias(e.target.value.toLowerCase())}
              placeholder="kitchen"
              className="font-mono sm:max-w-xs"
              aria-invalid={aliasInvalid || undefined}
              aria-describedby={`${id}-alias-help`}
              disabled={!canManage}
              autoComplete="off"
              spellCheck={false}
            />
            {canManage && (
              <Button type="submit" variant="outline" disabled={aliasInvalid || alias === (email.alias ?? '') || update.isPending}>
                {update.isPending && <Spinner data-icon="inline-start" />}
                Save name
              </Button>
            )}
          </div>
          <p id={`${id}-alias-help`} className={aliasInvalid ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {aliasInvalid ? (
              'Use lowercase letters, numbers, dots or dashes.'
            ) : (
              <>
                People send mail to <Mono>{alias || 'name'}@</Mono> followed by your print domain.
              </>
            )}
          </p>
        </form>
      )}
    </Section>
  )
}
