import { Printer as PrinterIcon } from 'lucide-react'
import { useState } from 'react'
import type { Client, Printer } from '@shared/types'
import { StatusPill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { usePrinters, useUpdatePrinter } from '@/hooks/printers'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { printerStatus } from '@/lib/words'
import { StepHeading } from './steps'

function PrinterChoice({ printer, checked, onChange }: { printer: Printer; checked: boolean; onChange: (checked: boolean) => void }) {
  const auto = printer.added
  return (
    <label
      className={cn(
        'press flex cursor-pointer items-start gap-4 rounded-2xl border bg-card p-4 hover:bg-muted',
        (checked || auto) && 'border-transparent bg-brand-container text-on-brand-container ring-2 ring-brand hover:bg-brand-container',
        auto && 'cursor-default',
      )}
    >
      <Checkbox className="mt-0.5" checked={checked || auto} disabled={auto} onCheckedChange={(c) => onChange(c === true)} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[0.9375rem] font-medium">{printer.name}</span>
        {printer.makeModel && printer.makeModel !== printer.name && <span className="text-sm opacity-80">{printer.makeModel}</span>}
        {auto && <span className="text-sm opacity-80">Added automatically</span>}
      </span>
      <StatusPill status={printerStatus(printer)} />
    </label>
  )
}

export function PickPrinters({ ws, client, onDone, onSkip }: { ws: string; client: Client; onDone: () => void; onSkip: () => void }) {
  const printers = (usePrinters(ws).data ?? []).filter((p) => p.clientId === client.id)
  const candidates = printers.filter((p) => !p.added)
  // Mirror the "smart" default: preselect when there are only a few to choose from.
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const selected = picked ?? new Set(candidates.length <= 3 ? candidates.map((p) => p.id) : [])
  const update = useUpdatePrinter(ws)
  const [saving, setSaving] = useState(false)

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }

  const add = async () => {
    setSaving(true)
    try {
      for (const id of selected) await update.mutateAsync({ id, patch: { added: true } })
      onDone()
    } catch {
      // The mutation layer shows the error; stay here so they can try again.
    } finally {
      setSaving(false)
    }
  }

  if (printers.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeading
          title="No printers found yet"
          description={`Turn your printers on and make sure they are plugged into ${client.name} or on the same network. New printers show up here by themselves.`}
        />
        <div className="flex items-center gap-3 text-muted-foreground" role="status">
          <Spinner /> Still looking…
        </div>
        <div>
          <Button variant="outline" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    )
  }

  const count = selected.size
  const alreadyAdded = printers.length - candidates.length
  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        title="Choose the printers to use"
        description="Printers you add can be printed to by everyone in this workspace. You can change this later."
      />
      <ul className="flex flex-col gap-2" aria-label="Printers found">
        {printers.map((p) => (
          <li key={p.id}>
            <PrinterChoice printer={p} checked={selected.has(p.id)} onChange={(on) => toggle(p.id, on)} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        {count > 0 ? (
          <Button size="lg" onClick={add} disabled={saving}>
            {saving ? <Spinner data-icon="inline-start" /> : <PrinterIcon data-icon="inline-start" />}
            Add {plural(count, 'printer')}
          </Button>
        ) : (
          <Button size="lg" onClick={alreadyAdded ? onDone : onSkip}>
            Continue
          </Button>
        )}
      </div>
    </div>
  )
}
