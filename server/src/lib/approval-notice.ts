import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { navigate } from 'wouter/use-browser-location'
import type { MyPrinterAccess } from '@shared/access'
import type { Job } from '@shared/types'
import { mayApprove, printerRights } from './access'
import type { SessionState } from './api/types'
import { qk } from './query'

/** Enterprise controls' `approval` event: a notice for whoever may approve the job, with a way to it. */
export function approvalNotice(qc: QueryClient, ws: string, job: Job) {
  const session = qc.getQueryData<SessionState>(qk.session)
  const role = session?.workspaces.find((w) => w.id === ws)?.role
  const rights = printerRights(qc.getQueryData<MyPrinterAccess>(qk.myAccess(ws)), role)
  if (!mayApprove(job, session?.user?.id, rights)) return
  toast(`“${job.title || 'Untitled'}” needs approval`, {
    id: `approval-${job.id}`,
    description: job.held?.reasons?.join('. '),
    action: { label: 'Review', onClick: () => navigate(`/w/${ws}/jobs/approvals`) },
  })
}
