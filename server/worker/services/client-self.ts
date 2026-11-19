import type { RemotePrinter } from '../../shared/protocol'
import type { ClientRow } from '../db/rows'
import { remoteSnapshots } from '../hub/remote-printers'
import { first } from '../lib/db'
import type { Ctx } from './context'
import { deviceAccess } from './permissions'

export interface ClientIdentity {
  clientId: string
  name: string
  workspaceId: string
  workspaceName: string | null
}

/** `GET /api/client/me`: the device's own name and workspace, which an app without a socket can't learn otherwise. */
export async function clientIdentity(env: Env, client: ClientRow): Promise<ClientIdentity> {
  const ws = await first<{ name: string }>(env.DB, 'SELECT name FROM workspaces WHERE id = ?', client.workspace_id)
  return { clientId: client.id, name: client.name, workspaceId: client.workspace_id, workspaceName: ws?.name ?? null }
}

/** `GET /api/client/printers`: the device's `remote_printers` snapshot, for devices that never open a socket. */
export async function clientPrinters(ctx: Ctx, client: ClientRow): Promise<{ printers: RemotePrinter[] }> {
  const access = await deviceAccess(ctx, client)
  const snapshots = await remoteSnapshots(ctx.env, client.workspace_id, [client.id], (_, printerId) => access.can(printerId, 'print'))
  return { printers: snapshots.get(client.id)?.printers ?? [] }
}
