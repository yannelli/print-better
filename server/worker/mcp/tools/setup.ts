import type { Printer } from '../../../shared/printing'
import type { Client } from '../../../shared/types'
import { ApiError } from '../../http/errors'
import { roleAtLeast } from '../../services/access'
import { listClients } from '../../services/clients'
import { listJobs } from '../../services/jobs'
import { listMembers } from '../../services/members'
import { listPrinters } from '../../services/printers'
import { getWorkspace } from '../../services/workspaces'
import { inWorkspace, output, READ, workspaceOf, type Tool } from '../tool'

interface Step {
  tool: string
  arguments: Record<string, unknown>
  why: string
}

const NEEDS_ADMIN = new Set(['create_device_install', 'update_printer', 'device_command', 'invite_member'])

interface State {
  workspaceId: string
  devices: Client[]
  printers: Printer[]
  printed: boolean
  members: number
}

function nextStep({ workspaceId, devices, printers, printed, members }: State): Step {
  const ws = { workspaceId }
  const online = devices.filter((d) => d.online)
  const added = printers.filter((p) => p.added)
  const discovered = printers.filter((p) => !p.added)
  if (devices.length === 0) {
    return { tool: 'create_device_install', arguments: ws, why: 'Pair a computer or Raspberry Pi that can reach the printers by running the returned command on it.' }
  }
  if (online.length === 0) {
    return { tool: 'list_devices', arguments: ws, why: 'No paired device is online yet; check that the install command finished and the device has network access.' }
  }
  if (added.length === 0 && discovered.length > 0) {
    return { tool: 'update_printer', arguments: { ...ws, printerId: discovered[0].id, added: true }, why: `Add the discovered printer "${discovered[0].name}".` }
  }
  if (added.length === 0) {
    return { tool: 'device_command', arguments: { ...ws, deviceId: online[0].id, name: 'discover' }, why: 'No printers found yet; search the network and USB again.' }
  }
  if (!printed) return { tool: 'print_test_page', arguments: { ...ws, printerId: added[0].id }, why: 'Confirm printing works end to end.' }
  if (members === 1) return { tool: 'invite_member', arguments: { ...ws, role: 'member' }, why: 'Optional: invite family or teammates.' }
  return { tool: 'print', arguments: { ...ws, printerId: added[0].id }, why: 'Setup is complete; print anything.' }
}

export const setupTool: Tool = {
  name: 'get_setup_status',
  title: 'Setup status',
  description:
    'Start here. Checklist for a workspace (devices paired and online, printers added, first print done, members invited) and the next tool to call, with its arguments.',
  scope: 'read',
  annotations: READ,
  inputSchema: inWorkspace(),
  run: async (ctx, args) => {
    let workspaceId: string
    try {
      workspaceId = await workspaceOf(ctx, args)
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'no_workspace')) throw e
      const next: Step = { tool: 'create_workspace', arguments: { name: 'Home' }, why: 'Devices, printers and members all live in a workspace.' }
      return output('No workspace yet. Next: create_workspace.', { checklist: null, next })
    }
    const [workspace, devices, printers, members, completed] = await Promise.all([
      getWorkspace(ctx, workspaceId),
      listClients(ctx, workspaceId),
      listPrinters(ctx, workspaceId),
      listMembers(ctx, workspaceId),
      listJobs(ctx, workspaceId, { status: 'completed', limit: '1' }),
    ])
    const state: State = { workspaceId, devices, printers, printed: completed.items.length > 0, members: members.length }
    const checklist = {
      devicesPaired: devices.length,
      devicesOnline: devices.filter((d) => d.online).length,
      printersAdded: printers.filter((p) => p.added).length,
      printersDiscovered: printers.filter((p) => !p.added).length,
      firstPrintDone: state.printed,
      members: members.length,
    }
    const next = nextStep(state)
    if (NEEDS_ADMIN.has(next.tool) && !roleAtLeast(workspace.role, 'admin')) next.why += ' This needs an admin or owner of the workspace.'
    const done = [checklist.devicesPaired > 0, checklist.devicesOnline > 0, checklist.printersAdded > 0, checklist.firstPrintDone, members.length > 1].filter(Boolean).length
    return output(`${workspace.name}: ${done} of 5 setup steps done. Next: ${next.tool}. ${next.why}`, {
      workspace: { id: workspace.id, name: workspace.name, role: workspace.role },
      checklist,
      next,
    })
  },
}
