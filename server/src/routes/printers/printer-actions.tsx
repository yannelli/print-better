import { FileCheck2, Lightbulb, Pencil, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'
import type { Printer } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { Row, Section } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { usePrinterAction, useRemovePrinter, useUpdatePrinter } from '@/hooks/printers'
import { RenameDialog } from './rename-dialog'

function ActionButton({ busy, icon, children, ...props }: React.ComponentProps<typeof Button> & { busy?: boolean; icon: ReactNode }) {
  return (
    <Button variant="outline" {...props} disabled={busy || props.disabled}>
      {busy ? <Spinner data-icon="inline-start" /> : icon}
      {children}
    </Button>
  )
}

export function PrinterActions({ ws, printer, canManage, canPrint }: { ws: string; printer: Printer; canManage: boolean; canPrint: boolean }) {
  const [, navigate] = useLocation()
  const [renaming, setRenaming] = useState(false)
  const identify = usePrinterAction(ws, 'identify')
  const refresh = usePrinterAction(ws, 'refresh')
  const testPage = usePrinterAction(ws, 'testPage')
  const update = useUpdatePrinter(ws)
  const remove = useRemovePrinter(ws)
  const offline = !printer.clientOnline
  const offlineHint = offline ? `Turn on ${printer.clientName} to use this.` : undefined
  const setAdded = (added: boolean) =>
    update.mutate(
      { id: printer.id, patch: { added } },
      {
        onSuccess: () => {
          toast.success(added ? `${printer.name} is ready to use` : `${printer.name} is no longer in use`)
          if (!added) navigate(wsHref(ws, '/printers'))
        },
      },
    )

  return (
    <Section title="Tools" id="tools" flush>
      {canPrint && (
        <>
          <Row label="Find this printer" description={offlineHint ?? 'Makes the printer beep or flash its lights, if it can.'}>
            <ActionButton icon={<Lightbulb data-icon="inline-start" />} busy={identify.isPending} disabled={offline} onClick={() => identify.mutate(printer.id)}>
              Beep or flash
            </ActionButton>
          </Row>
          <Row label="Test page" description="Prints one page to check that everything works.">
            <ActionButton icon={<FileCheck2 data-icon="inline-start" />} busy={testPage.isPending} onClick={() => testPage.mutate(printer.id)}>
              Print a test page
            </ActionButton>
          </Row>
        </>
      )}
      <Row label="Check status now" description={offlineHint ?? 'Asks the printer for its latest status and ink levels.'}>
        <ActionButton icon={<RefreshCw data-icon="inline-start" />} busy={refresh.isPending} disabled={offline} onClick={() => refresh.mutate(printer.id)}>
          Check again
        </ActionButton>
      </Row>
      {canManage && (
        <>
          <Row label="Name and place" description={printer.location ? `${printer.name}, ${printer.location}` : printer.name}>
            <ActionButton icon={<Pencil data-icon="inline-start" />} onClick={() => setRenaming(true)}>
              Change
            </ActionButton>
          </Row>
          {printer.added ? (
            <Row label="Stop using this printer" description="Hides it from the print menu. It stays in the found list so you can add it back.">
              <ActionButton icon={<Undo2 data-icon="inline-start" />} busy={update.isPending} onClick={() => setAdded(false)}>
                Stop using
              </ActionButton>
            </Row>
          ) : (
            <Row label="Use this printer" description="Adds it to the print menu for everyone in this workspace.">
              <ActionButton icon={<Plus data-icon="inline-start" />} busy={update.isPending} onClick={() => setAdded(true)}>
                Use this printer
              </ActionButton>
            </Row>
          )}
          <Row label="Forget this printer" description="Removes it and its settings. If it is found again, it comes back as a new printer.">
            <Confirm
              trigger={
                <Button variant="destructive">
                  <Trash2 data-icon="inline-start" />
                  Forget printer
                </Button>
              }
              title={`Forget ${printer.name}?`}
              description="Its default settings and sharing options will be lost. Past print jobs stay in the list."
              confirmLabel="Forget printer"
              destructive
              onConfirm={() => remove.mutateAsync(printer.id).then(() => navigate(wsHref(ws, '/printers')))}
            />
          </Row>
          <RenameDialog ws={ws} printer={printer} open={renaming} onOpenChange={setRenaming} key={renaming ? 'open' : 'closed'} />
        </>
      )}
    </Section>
  )
}
