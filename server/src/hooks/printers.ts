import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Job, Printer } from '@shared/types'
import { type PrinterPatch, printersApi } from '@/lib/api/printers'
import { dropPrinter, putJob, putPrinter } from '@/lib/cache'
import { qk } from '@/lib/query'

export function usePrinters(ws: string) {
  return useQuery({ queryKey: qk.printers(ws), queryFn: () => printersApi.list(ws) })
}

/** Printers people can print to (added to the workspace), in a stable order. */
export function useAddedPrinters(ws: string) {
  return useQuery({
    queryKey: qk.printers(ws),
    queryFn: () => printersApi.list(ws),
    select: (list: Printer[]) => list.filter((p) => p.added).sort((a, b) => a.name.localeCompare(b.name)),
  })
}

export function usePrinter(ws: string, id: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.printer(ws, id),
    queryFn: () => printersApi.get(ws, id),
    initialData: () => qc.getQueryData<Printer[]>(qk.printers(ws))?.find((p) => p.id === id),
    initialDataUpdatedAt: () => qc.getQueryState(qk.printers(ws))?.dataUpdatedAt,
  })
}

export function useUpdatePrinter(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PrinterPatch }) => printersApi.update(ws, id, patch),
    onSuccess: (printer) => putPrinter(qc, ws, printer),
  })
}

export function useRemovePrinter(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => printersApi.remove(ws, id),
    onSuccess: (_d, id) => dropPrinter(qc, ws, id),
    meta: { success: 'Printer removed' },
  })
}

export function usePrinterAction(ws: string, action: 'identify' | 'refresh' | 'testPage') {
  const qc = useQueryClient()
  const success = {
    identify: 'The printer should beep or flash now',
    refresh: 'Checking the printer again',
    testPage: 'Test page sent',
  }[action]
  return useMutation({
    mutationFn: (id: string): Promise<unknown> => printersApi[action](ws, id),
    onSuccess: (data) => {
      const job = (data as { job?: Job } | undefined)?.job
      if (job) putJob(qc, ws, job)
    },
    meta: { success },
  })
}
