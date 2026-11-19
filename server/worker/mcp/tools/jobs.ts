import type { Job } from '../../../shared/printing'
import { optStr, str } from '../../http/validate'
import { createJob } from '../../services/job-create'
import { cancelJob, getJob, listJobs, retryJob } from '../../services/jobs'
import { ACTION, choice, inWorkspace, integer, output, pick, READ, REMOVE, text, workspaceOf, type Tool } from '../tool'
import { DOC_TYPE, JOB_OPTIONS } from './schemas'

const JOB_ID = text('Job id, from list_jobs or print')
const jobIdOf = (args: Record<string, unknown>) => str(args, 'jobId', { max: 64 })
const STATUSES = ['uploading', 'queued', 'dispatched', 'printing', 'completed', 'failed', 'canceled'] as const

const describe = (j: Job) => `"${j.title}" on ${j.printerName ?? 'a removed printer'}: ${j.status}${j.statusMessage ? ` (${j.statusMessage})` : ''}`

export const jobTools: Tool[] = [
  {
    name: 'print',
    title: 'Print',
    description:
      'Prints exactly one of: text, a url the server fetches, or base64 file bytes with contentType and fileName (PDF, JPEG, PNG or plain text, within the workspace upload limit). Omit printerId to use the default printer.',
    scope: 'print',
    annotations: ACTION,
    inputSchema: inWorkspace({
      printerId: text('Printer id; omit to use the workspace default printer'),
      title: text('Name shown in the print queue'),
      text: text('Plain text to print'),
      url: text('http(s) URL of a PDF, JPEG, PNG or text file'),
      base64: text('File contents, base64-encoded'),
      contentType: DOC_TYPE,
      fileName: text('File name for the base64 document, e.g. "boarding-pass.pdf"'),
      options: JOB_OPTIONS,
    }),
    run: async (ctx, args) => {
      // costCenter is accepted only while an extension adds it to this tool (extensions/tools.ts).
      const body = pick(args, ['printerId', 'title', 'text', 'url', 'base64', 'contentType', 'fileName', 'options', 'costCenter'])
      const { job } = await createJob(ctx, await workspaceOf(ctx, args), body)
      return output(`Queued ${describe(job)}. Job id ${job.id}; check progress with get_job.`, { job })
    },
  },
  {
    name: 'list_jobs',
    title: 'List print jobs',
    description: 'Print jobs, newest first, optionally for one printer or status.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({
      printerId: text('Only jobs for this printer'),
      status: choice('Only jobs with this status', STATUSES),
      cursor: text('nextCursor from the previous page'),
      limit: integer('Jobs per page', 1, 200),
    }),
    run: async (ctx, args) => {
      const page = await listJobs(ctx, await workspaceOf(ctx, args), {
        printerId: optStr(args, 'printerId', { max: 64 }) ?? null,
        status: optStr(args, 'status', { max: 20 }) ?? null,
        cursor: optStr(args, 'cursor', { max: 200 }) ?? null,
        limit: args.limit === undefined ? null : String(args.limit),
      })
      const lines = page.items.map((j) => `${j.id} ${describe(j)}`).join('\n')
      return output(lines || 'No jobs.', { items: page.items, nextCursor: page.nextCursor })
    },
  },
  {
    name: 'get_job',
    title: 'Get print job',
    description: 'One print job with its status, pages and any problem message.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ jobId: JOB_ID }, ['jobId']),
    run: async (ctx, args) => {
      const job = await getJob(ctx, await workspaceOf(ctx, args), jobIdOf(args))
      return output(describe(job), { job })
    },
  },
  {
    name: 'cancel_job',
    title: 'Cancel print job',
    description: 'Cancels a job that has not finished. Members may cancel their own jobs; admins any job.',
    scope: 'print',
    annotations: REMOVE,
    inputSchema: inWorkspace({ jobId: JOB_ID }, ['jobId']),
    run: async (ctx, args) => {
      const job = await cancelJob(ctx, await workspaceOf(ctx, args), jobIdOf(args))
      return output(describe(job), { job })
    },
  },
  {
    name: 'retry_job',
    title: 'Retry print job',
    description: 'Prints a failed or canceled job again, if its document is still stored.',
    scope: 'print',
    annotations: ACTION,
    inputSchema: inWorkspace({ jobId: JOB_ID }, ['jobId']),
    run: async (ctx, args) => {
      const job = await retryJob(ctx, await workspaceOf(ctx, args), jobIdOf(args))
      return output(`Retrying ${describe(job)}.`, { job })
    },
  },
]
