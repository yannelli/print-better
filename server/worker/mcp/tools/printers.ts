import type { Printer } from '../../../shared/printing'
import { str } from '../../http/validate'
import { deletePrinter, getPrinter, identifyPrinter, listPrinters, patchPrinter, printTestPage } from '../../services/printers'
import { ACTION, bool, inWorkspace, nullableText, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Tool } from '../tool'
import { JOB_OPTIONS, PRINTER_SETTINGS } from './schemas'

const PRINTER_ID = text('Printer id, from list_printers')
const printerIdOf = (args: Record<string, unknown>) => str(args, 'printerId', { max: 64 })

/** Lists leave out routes and the full capability set, which get_printer returns. */
const brief = ({ routes: _routes, capabilities: _capabilities, ...printer }: Printer) => printer

const describe = (p: Printer) => `${p.name}: ${p.status.state}${p.added ? '' : ' (discovered, not added)'}${p.clientOnline ? '' : ', device offline'}`

export const printerTools: Tool[] = [
  {
    name: 'list_printers',
    title: 'List printers',
    description: 'Printers in the workspace and ones devices discovered but not yet added, with status and supply levels.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ added: bool('true: only added printers; false: only discovered ones; omit for both') }),
    run: async (ctx, args) => {
      const printers = await listPrinters(ctx, await workspaceOf(ctx, args), typeof args.added === 'boolean' ? String(args.added) : null)
      return output(printers.length ? printers.map(describe).join('\n') : 'No printers yet.', { printers: printers.map(brief) })
    },
  },
  {
    name: 'get_printer',
    title: 'Get printer',
    description: 'One printer with status, supplies, capabilities (paper sizes, duplex, color), connection routes and print defaults.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ printerId: PRINTER_ID }, ['printerId']),
    run: async (ctx, args) => {
      const printer = await getPrinter(ctx, await workspaceOf(ctx, args), printerIdOf(args))
      return output(describe(printer), { printer })
    },
  },
  {
    name: 'update_printer',
    title: 'Update printer',
    description:
      'Adds a discovered printer to the workspace (added: true) or removes it (added: false; it stays discovered), renames it, sets its location, replaces its print defaults, or changes LAN sharing and its email alias. Admins and owners only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace(
      {
        printerId: PRINTER_ID,
        added: bool('Whether the printer is part of the workspace'),
        name: text('Display name'),
        location: nullableText('Where the printer is, e.g. "Kitchen"; null clears it'),
        defaults: { ...JOB_OPTIONS, description: 'Default print options; replaces the current defaults entirely' },
        settings: PRINTER_SETTINGS,
      },
      ['printerId'],
    ),
    run: async (ctx, args) => {
      const printer = await patchPrinter(ctx, await workspaceOf(ctx, args), printerIdOf(args), pick(args, ['added', 'name', 'location', 'defaults', 'settings']))
      return output(`Updated ${describe(printer)}.`, { printer })
    },
  },
  {
    name: 'remove_printer',
    title: 'Forget printer',
    description: 'Forgets a printer. If its device still sees it, it comes back as discovered (not added). Admins and owners only.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ printerId: PRINTER_ID }, ['printerId']),
    run: async (ctx, args) => {
      const id = printerIdOf(args)
      await deletePrinter(ctx, await workspaceOf(ctx, args), id)
      return output(`Forgot printer ${id}.`, { removed: id })
    },
  },
  {
    name: 'identify_printer',
    title: 'Identify printer',
    description: 'Asks the printer to show itself (beep, blink, or show a message) so you can find it. Needs its device online.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace({ printerId: PRINTER_ID }, ['printerId']),
    run: async (ctx, args) => {
      const result = await identifyPrinter(ctx, await workspaceOf(ctx, args), printerIdOf(args))
      return output(result.ok ? 'Sent identify to the printer.' : `The printer could not identify itself: ${result.error ?? 'unknown error'}`, { result })
    },
  },
  {
    name: 'print_test_page',
    title: 'Print test page',
    description: 'Queues the built-in one-page test PDF on a printer that has been added to the workspace.',
    scope: 'print',
    annotations: ACTION,
    inputSchema: inWorkspace({ printerId: PRINTER_ID }, ['printerId']),
    run: async (ctx, args) => {
      const { job } = await printTestPage(ctx, await workspaceOf(ctx, args), printerIdOf(args))
      return output(`Queued a test page on ${job.printerName ?? 'the printer'} (job ${job.id}). Check it with get_job.`, { job })
    },
  },
]
