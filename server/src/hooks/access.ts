import { useQuery } from '@tanstack/react-query'
import { myAccess, subjectAccess } from '@/lib/api/access'
import { printerRights } from '@/lib/access'
import { qk } from '@/lib/query'
import { useAddedPrinters } from './printers'
import { useCanManage, useRole } from './workspace'

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

/** A device's permissions on every printer; asked only while printer access is on, and only by admins. */
export function useDeviceAccess(ws: string, clientId: string) {
  const { managed } = usePrinterRights(ws)
  const canManage = useCanManage()
  return useQuery({
    queryKey: [...qk.access(ws), 'subject', `client:${clientId}`],
    queryFn: () => subjectAccess(ws, { type: 'client', id: clientId }),
    enabled: managed && canManage,
  })
}

/** Whether a device may print to each printer. `null` while printer access is off (no limits) or not loaded. */
export function useDevicePrintable(ws: string, clientId: string): ((printerId: string) => boolean) | null {
  const { managed } = usePrinterRights(ws)
  const printers = useDeviceAccess(ws, clientId).data?.printers
  if (!managed || !printers) return null
  return (printerId) => !!printers[printerId]?.includes('print')
}
