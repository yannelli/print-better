import { optStr, str } from '../../http/validate'
import { bool, choice, inWorkspace, object, output, pick, READ, text, UPDATE, workspaceOf, type Schema, type Tool } from '../../mcp/tool'
import { getUsageReport } from './exports'
import { getEnterprise, patchEnterprise, setPrinterControls } from './settings'
import { costTools } from './tools-costs'
import { holdTools } from './tools-holds'
import { DIMENSIONS } from './values'

const part = (description: string, properties: Record<string, Schema>): Schema => object(properties, [], description)
const hours = (description: string, max: number): Schema => ({ type: 'integer', minimum: 1, maximum: max, description })

const SETTINGS = {
  approvals: part('Approvals', { enabled: bool('On or off'), expiryHours: hours('Hours before an unanswered request is canceled', 168) }),
  release: part('Secure release', { enabled: bool('On or off'), expiryHours: hours('Hours before a job nobody released is canceled', 72) }),
  costCenters: part('Cost centers and budgets', { enabled: bool('On or off'), required: bool('Every job needs a cost center') }),
  reports: part('Reports', { enabled: bool('On or off') }),
  alerts: part('Usage alerts at 80% and 100%', {
    enabled: bool('On or off'),
    personal: bool('Email the person a personal limit counts'),
    admins: bool('Email the admin recipients'),
    recipients: { type: ['array', 'null'], items: { type: 'string' }, description: 'Member ids for admin alerts; null for every owner and admin' },
  }),
  privacy: part('Retention and privacy (owners only)', {
    enabled: bool('On or off'),
    deleteWhenFinished: bool('Delete documents as soon as a job finishes'),
    ownerOnlyNames: bool('Show document names only to the person who printed them'),
    adminsSeeNames: bool('Owners and admins still see names'),
  }),
}

const onOff = (on: boolean) => (on ? 'on' : 'off')

const settingsTools: Tool[] = [
  {
    name: 'get_enterprise_settings',
    title: 'Get enterprise settings',
    description: 'Each part of Enterprise controls with its switch and settings, and the printers that need approval or hold jobs for release.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const config = await getEnterprise(ctx, await workspaceOf(ctx, args))
      const parts = Object.entries(config.settings).map(([name, s]) => `${name}: ${onOff(s.enabled)}`)
      return output(`${parts.join(', ')}. ${Object.keys(config.printers).length} printers with controls.`, { config })
    },
  },
  {
    name: 'update_enterprise_settings',
    title: 'Update enterprise settings',
    description:
      'Turns parts of Enterprise controls on or off and changes their settings; each part is merged. Turning approvals or secure release off cancels the jobs waiting for it. Admins; privacy needs an owner.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace(SETTINGS),
    run: async (ctx, args) => {
      const config = await patchEnterprise(ctx, await workspaceOf(ctx, args), pick(args, Object.keys(SETTINGS)))
      return output(`Saved. ${Object.entries(config.settings).map(([name, s]) => `${name}: ${onOff(s.enabled)}`).join(', ')}.`, { config })
    },
  },
  {
    name: 'set_printer_controls',
    title: 'Set printer controls',
    description: 'Turns a printer’s "Every job needs approval" and "Hold jobs until released" switches on or off. Admins, or settings on the printer.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ printerId: text('Printer id, from list_printers'), approval: bool('Every job needs approval'), secureRelease: bool('Hold every job until its sender releases it') }, ['printerId']),
    run: async (ctx, args) => {
      const controls = await setPrinterControls(ctx, await workspaceOf(ctx, args), str(args, 'printerId', { max: 64 }), pick(args, ['approval', 'secureRelease']))
      return output(`Approval ${onOff(controls.approval)}, secure release ${onOff(controls.secureRelease)}.`, { controls })
    },
  },
  {
    name: 'usage_report',
    title: 'Usage report',
    description: 'Jobs, pages, sheets, color pages and cost by member, group, device, printer, cost center or source, for local dates in the workspace time zone. Defaults to this month so far. Admins only.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ by: choice('Group the rows by', DIMENSIONS), from: text('First day, e.g. 2026-11-01'), to: text('Last day, included') }, ['by']),
    run: async (ctx, args) => {
      const report = await getUsageReport(ctx, await workspaceOf(ctx, args), {
        by: optStr(args, 'by', { max: 20 }) ?? null,
        from: optStr(args, 'from', { max: 10 }) ?? null,
        to: optStr(args, 'to', { max: 10 }) ?? null,
        format: null,
      })
      if (report instanceof Response) throw new Error('usage_report never asks for CSV')
      const t = report.totals
      const rows = report.rows.slice(0, 20).map((r) => `${r.name}: ${r.jobs} jobs, ${r.pages} pages, cost ${r.costMicros / 1_000_000} ${report.currency}`)
      return output([`${report.from} to ${report.to}: ${t.jobs} jobs, ${t.pages} pages, cost ${t.costMicros / 1_000_000} ${report.currency}`, ...rows].join('\n'), { report })
    },
  },
]

/** Listed only while the extension is available on the instance (extensions/tools.ts). */
export const enterpriseTools: Tool[] = [...holdTools, ...costTools, ...settingsTools]
