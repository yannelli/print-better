import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'wouter'
import type { Job, JobOptions, Printer } from '@shared/types'
import { type PrintRequest, wsHref } from '@/components/shell/app-actions'
import { Loading } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Slot } from '@/extensions/slot'
import { usePrintablePrinters } from '@/hooks/access'
import { useWorkspace } from '@/hooks/workspace'
import { errorMessage } from '@/lib/api/http'
import { NO_PRINT_ACCESS, printerStatus } from '@/lib/words'
import { ChoiceSelect } from './choice-select'
import { changedOptions, startingOptions } from './job-options'
import { JobOptionsFields, pageRangesValid } from './job-options-fields'
import { SentState } from './sent-state'
import { type SourceDraft, SourcePicker, sourceProblem } from './source-picker'
import { usePrintSubmit } from './use-print-submit'

function pickPrinter(printers: Printer[], wanted: string | null, workspaceDefault: string | null | undefined) {
  return (
    printers.find((p) => p.id === wanted) ??
    printers.find((p) => p.id === workspaceDefault) ??
    printers.find((p) => p.clientOnline) ??
    printers[0]
  )
}

export function PrintForm({
  ws,
  request,
  onBusyChange,
  onClose,
}: {
  ws: string
  request: PrintRequest
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}) {
  const id = useId()
  const printers = usePrintablePrinters(ws)
  const workspace = useWorkspace(ws).data
  const submit = usePrintSubmit(ws)
  const [printerId, setPrinterId] = useState<string | null>(request.printerId ?? null)
  const [source, setSource] = useState<SourceDraft>({ kind: 'file', file: request.file ?? null })
  const [edits, setEdits] = useState<{ printerId: string; value: JobOptions } | null>(null)
  const [sent, setSent] = useState<Job | null>(null)
  const [extra, setExtraFields] = useState<Record<string, unknown>>({})
  const setExtra = (fields: Record<string, unknown>) => setExtraFields((current) => ({ ...current, ...fields }))
  // Extensions read the typed text as a file, so it is counted like an upload.
  const typed = useMemo(() => (source.kind === 'text' && source.text.trim() ? new File([source.text], 'text.txt', { type: 'text/plain' }) : null), [source])
  const uploading = submit.progress !== null

  useEffect(() => onBusyChange(submit.isPending), [submit.isPending, onBusyChange])

  if (printers.isPending) return <Loading label="Loading printers" />
  const list = printers.data ?? []
  const printer = pickPrinter(list, printerId, workspace?.settings.defaultPrinterId)

  if (!printer && (printers.added?.length ?? 0) > 0) {
    return (
      <div className="flex flex-col gap-6">
        <DialogHeader>
          <DialogTitle>No printer you can print to</DialogTitle>
          <DialogDescription>{NO_PRINT_ACCESS}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </div>
    )
  }

  if (!printer) {
    return (
      <div className="flex flex-col gap-6">
        <DialogHeader>
          <DialogTitle>No printers yet</DialogTitle>
          <DialogDescription>Add a device that is connected to your printer, then you can print from here.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Link href={wsHref(ws, '/devices/add')} onClick={onClose} className={buttonVariants()}>
            Add a device
          </Link>
        </DialogFooter>
      </div>
    )
  }

  if (sent) {
    return (
      <SentState
        ws={ws}
        job={sent}
        printerName={printer.name}
        onAnother={() => {
          setSent(null)
          setSource({ kind: 'file', file: null })
          submit.reset()
        }}
        onDone={onClose}
      />
    )
  }

  const start = startingOptions(printer)
  const options = edits?.printerId === printer.id ? edits.value : start
  const maxMb = workspace?.settings.maxUploadMb ?? 50
  const problem = sourceProblem(source, maxMb)
  const hasContent = source.kind === 'file' ? !!source.file : source.text.trim().length > 0
  const ready = hasContent && !problem && pageRangesValid(options)
  const status = printerStatus(printer)

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    const payload = source.kind === 'file' ? { kind: 'file' as const, file: source.file! } : source
    submit.mutate({ printerId: printer.id, options: changedOptions(start, options), source: payload, extra }, { onSuccess: setSent })
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>Print something</DialogTitle>
        <DialogDescription>Choose what to print and which printer to use.</DialogDescription>
      </DialogHeader>
      <SourcePicker value={source} onChange={setSource} problem={problem} disabled={submit.isPending} />
      <Field>
        <FieldLabel htmlFor={`${id}-printer`}>Printer</FieldLabel>
        <ChoiceSelect
          id={`${id}-printer`}
          value={printer.id}
          onChange={setPrinterId}
          options={list.map((p) => ({ value: p.id, label: p.clientOnline ? p.name : `${p.name} (offline)` }))}
          disabled={submit.isPending}
        />
        {status.tone !== 'ok' && status.tone !== 'info' && (
          <FieldDescription>
            {status.label}. It will print as soon as the printer is ready{printer.clientOnline ? '' : ` and ${printer.clientName} is back online`}.
          </FieldDescription>
        )}
      </Field>
      <JobOptionsFields
        key={printer.id}
        printer={printer}
        value={options}
        onChange={(value) => setEdits({ printerId: printer.id, value })}
        mode="print"
        disabled={submit.isPending}
      />
      <Slot
        name="printForm"
        props={{ ws, draft: { printerId: printer.id, options: changedOptions(start, options), document: source.kind === 'file' ? source.file : typed }, extra, setExtra }}
      />
      {uploading && (
        <Progress value={Math.round((submit.progress ?? 0) * 100)} className="gap-2">
          <ProgressLabel>Uploading</ProgressLabel>
          <ProgressValue />
          <span className="sr-only" aria-live="polite">
            Uploading, {Math.floor((submit.progress ?? 0) * 4) * 25} percent
          </span>
        </Progress>
      )}
      {submit.error && <FieldError>{errorMessage(submit.error)}</FieldError>}
      <DialogFooter>
        {uploading ? (
          <Button type="button" variant="outline" onClick={submit.cancelUpload}>
            Stop upload
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onClose} disabled={submit.isPending}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!ready || submit.isPending}>
          {submit.isPending && <Spinner data-icon="inline-start" />}
          {submit.isPending ? 'Sending' : 'Print'}
        </Button>
      </DialogFooter>
    </form>
  )
}
