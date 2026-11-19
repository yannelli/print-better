import { useState } from 'react'
import { toast } from 'sonner'
import type { JobOptions, Printer } from '@shared/types'
import { Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useUpdatePrinter } from '@/hooks/printers'
import { startingOptions } from '../print/job-options'
import { JobOptionsFields } from '../print/job-options-fields'

function same(a: JobOptions, b: JobOptions) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof JobOptions>
  return [...keys].every((k) => (a[k] ?? '') === (b[k] ?? ''))
}

export function PrinterDefaults({ ws, printer, canManage }: { ws: string; printer: Printer; canManage: boolean }) {
  const update = useUpdatePrinter(ws)
  const start = startingOptions(printer)
  const [draft, setDraft] = useState<JobOptions | null>(null)
  const value = draft ?? start
  const dirty = draft !== null && !same(draft, start)

  const save = () => {
    const { pageRanges: _ignored, ...defaults } = value
    update.mutate(
      { id: printer.id, patch: { defaults } },
      {
        onSuccess: () => {
          setDraft(null)
          toast.success('Default settings saved')
        },
      },
    )
  }

  return (
    <Section
      title="Default settings"
      description={
        canManage
          ? 'Used for every print unless someone picks something else.'
          : 'Used for every print unless you pick something else. Only admins can change these.'
      }
      id="defaults"
    >
      <div className="flex flex-col gap-6">
        <JobOptionsFields printer={printer} value={value} onChange={setDraft} mode="defaults" disabled={!canManage || update.isPending} />
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={!dirty || update.isPending} variant={dirty ? 'default' : 'outline'}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              Save defaults
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={update.isPending}>
                Undo changes
              </Button>
            )}
            <span aria-live="polite" className="text-sm text-muted-foreground">
              {dirty ? 'You have unsaved changes.' : ''}
            </span>
          </div>
        )}
      </div>
    </Section>
  )
}
