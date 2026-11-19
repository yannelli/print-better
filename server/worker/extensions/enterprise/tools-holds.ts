import type { Job } from '../../../shared/printing'
import { str } from '../../http/validate'
import { ACTION, bool, inWorkspace, output, pick, READ, text, workspaceOf, type Tool } from '../../mcp/tool'
import { approveJob, denyJob, listApprovals } from './approvals'
import { listRelease, releaseAll, releaseJob } from './release'

const JOB_ID = text('Job id, from list_approvals, list_ready_to_release or list_jobs')
const jobIdOf = (args: Record<string, unknown>) => str(args, 'jobId', { max: 64 })

const line = (j: Job) => {
  const why = j.held?.reasons?.length ? ` (${j.held.reasons.join('; ')})` : ''
  const until = j.held ? `, until ${new Date(j.held.until).toISOString()}` : ''
  return `${j.id} "${j.title}" on ${j.printerName ?? 'a removed printer'}: ${j.statusMessage ?? j.status}${why}${until}`
}
const lines = (jobs: Job[], empty: string) => jobs.map(line).join('\n') || empty

export const holdTools: Tool[] = [
  {
    name: 'list_approvals',
    title: 'List jobs waiting for approval',
    description: 'Jobs waiting for approval that you may approve, oldest first, with why each one waits. Needs Enterprise controls with approvals on.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const jobs = await listApprovals(ctx, await workspaceOf(ctx, args))
      return output(lines(jobs, 'No jobs are waiting for your approval.'), { jobs })
    },
  },
  {
    name: 'approve_job',
    title: 'Approve print job',
    description:
      'Approves a job waiting for approval: it prints, or waits for its sender to release it when its printer or a rule asks for that. Owners and admins, or jobs.manage on the printer with Printer access; you cannot approve your own job unless you are an owner or admin.',
    scope: 'print',
    annotations: ACTION,
    inputSchema: inWorkspace({ jobId: JOB_ID, note: text('Optional note shown on the job') }, ['jobId']),
    run: async (ctx, args) => {
      const job = await approveJob(ctx, await workspaceOf(ctx, args), jobIdOf(args), pick(args, ['note']))
      return output(`Approved. ${line(job)}`, { job })
    },
  },
  {
    name: 'deny_job',
    title: 'Deny print job',
    description: 'Denies a job waiting for approval. It is canceled, and the sender sees "Not approved: <reason>".',
    scope: 'print',
    annotations: ACTION,
    inputSchema: inWorkspace({ jobId: JOB_ID, reason: text('Why, shown to the sender') }, ['jobId', 'reason']),
    run: async (ctx, args) => {
      const job = await denyJob(ctx, await workspaceOf(ctx, args), jobIdOf(args), pick(args, ['reason']))
      return output(`Denied. ${line(job)}`, { job })
    },
  },
  {
    name: 'list_ready_to_release',
    title: 'List jobs ready to release',
    description: 'Your jobs held until you release them at the printer. Owners and admins can pass everyone: true. Needs secure release on.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ everyone: bool('Owners and admins: everyone’s jobs, not only yours') }),
    run: async (ctx, args) => {
      const jobs = await listRelease(ctx, await workspaceOf(ctx, args), args.everyone === true)
      return output(lines(jobs, 'No jobs are waiting to be released.'), { jobs })
    },
  },
  {
    name: 'release_job',
    title: 'Release print job',
    description: 'Releases a held job so it prints now. Omit jobId to release all of your own. Only the sender, owners and admins can release a job.',
    scope: 'print',
    annotations: ACTION,
    inputSchema: inWorkspace({ jobId: text('Job id; omit to release all of your jobs') }),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      if (args.jobId === undefined) {
        const { released } = await releaseAll(ctx, ws)
        return output(released.length ? `Released ${released.length}:\n${lines(released, '')}` : 'Nothing was waiting to be released.', { released })
      }
      const job = await releaseJob(ctx, ws, jobIdOf(args))
      return output(`Released. ${line(job)}`, { job })
    },
  },
]
