import { useQuery } from '@tanstack/react-query'
import { myAccess } from '@/lib/api/access'
import { printerRights } from '@/lib/access'
import { qk } from '@/lib/query'
import { useAddedPrinters } from './printers'
import { useRole } from './workspace'

export function useMyAccess(ws: string) {
  return useQuery({ queryKey: qk.myAccess(ws), queryFn: () => myAccess(ws) })
}

/** What I may do with each printer (see `printerRights`). */
export function usePrinterRights(ws: string) {
  return printerRights(useMyAccess(ws).data, useRole())
}

/** Added printers I can print to, in a stable order; `added` is every added printer I can see. */
export function usePrintablePrinters(ws: string) {
  const rights = usePrinterRights(ws)
  const added = useAddedPrinters(ws)
  return {
    data: added.data?.filter((p) => rights.can(p.id, 'print')),
    added: added.data,
    isPending: added.isPending,
    error: added.error,
    refetch: added.refetch,
  }
}
