import { ctxOf } from '../http/authenticate'
import { MB, readJson } from '../http/body'
import type { Router } from '../http/router'
import { createJob } from '../services/job-create'
import { cancelJob, deleteJob, getJob, jobDocument, listJobs, retryJob } from '../services/jobs'
import { myPrinterAccess } from '../services/permissions'
import { deletePrinter, getPrinter, identifyPrinter, listPrinters, patchPrinter, printTestPage, refreshPrinter } from '../services/printers'
import { uploadJobFile } from '../services/upload'
import { documentResponse } from './respond'

// Text jobs travel inline in the JSON body, so job creation accepts more than the default 64 KB.
const JOB_JSON_LIMIT = 6 * MB

export function printerRoutes(r: Router): void {
  r.get('/api/workspaces/:ws/printers', async (h) => listPrinters(await ctxOf(h), h.params.ws, h.url.searchParams.get('added')))
  r.get('/api/workspaces/:ws/printers/:id', async (h) => getPrinter(await ctxOf(h), h.params.ws, h.params.id))
  r.patch('/api/workspaces/:ws/printers/:id', async (h) => patchPrinter(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete('/api/workspaces/:ws/printers/:id', async (h) => {
    await deletePrinter(await ctxOf(h), h.params.ws, h.params.id)
  })
  r.post('/api/workspaces/:ws/printers/:id/identify', async (h) => identifyPrinter(await ctxOf(h), h.params.ws, h.params.id))
  r.post('/api/workspaces/:ws/printers/:id/refresh', async (h) => refreshPrinter(await ctxOf(h), h.params.ws, h.params.id))
  r.post('/api/workspaces/:ws/printers/:id/test-page', async (h) => printTestPage(await ctxOf(h), h.params.ws, h.params.id))
  r.get('/api/workspaces/:ws/access/me', async (h) => myPrinterAccess(await ctxOf(h), h.params.ws))
}

export function jobRoutes(r: Router): void {
  r.get('/api/workspaces/:ws/jobs', async (h) => {
    const q = h.url.searchParams
    return listJobs(await ctxOf(h), h.params.ws, { printerId: q.get('printerId'), status: q.get('status'), cursor: q.get('cursor'), limit: q.get('limit') })
  })
  r.post('/api/workspaces/:ws/jobs', async (h) => createJob(await ctxOf(h), h.params.ws, await readJson(h.req, JOB_JSON_LIMIT)))
  r.put('/api/workspaces/:ws/jobs/:id/file', async (h) => ({ job: await uploadJobFile(await ctxOf(h), h.params.ws, h.params.id, h.req) }))
  r.get('/api/workspaces/:ws/jobs/:id', async (h) => getJob(await ctxOf(h), h.params.ws, h.params.id))
  r.get('/api/workspaces/:ws/jobs/:id/file', async (h) => {
    const { job, object, fileName } = await jobDocument(await ctxOf(h), h.params.ws, h.params.id)
    return documentResponse(job, object, fileName)
  })
  r.post('/api/workspaces/:ws/jobs/:id/cancel', async (h) => cancelJob(await ctxOf(h), h.params.ws, h.params.id))
  r.post('/api/workspaces/:ws/jobs/:id/retry', async (h) => retryJob(await ctxOf(h), h.params.ws, h.params.id))
  r.delete('/api/workspaces/:ws/jobs/:id', async (h) => {
    await deleteJob(await ctxOf(h), h.params.ws, h.params.id)
  })
}
