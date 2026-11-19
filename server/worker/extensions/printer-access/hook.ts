import type { PrinterPermission } from '../../../shared/access'
import type { AccessPrincipal, PrinterPolicyHook } from '../hooks'
import { evaluator } from './policy'
import { EXTENSION, loadPolicyData } from './store'

function principalKey(p: AccessPrincipal): string {
  switch (p.kind) {
    case 'member':
      return `member:${p.userId}:${p.role}`
    case 'device':
      return `device:${p.clientId}`
    case 'group':
      return `group:${p.groupId}`
    case 'everyone':
      return 'everyone'
  }
}

/** Answers the core's printer questions from this workspace's groups, roles and grants. */
export const printerAccessPolicy: PrinterPolicyHook = {
  extension: EXTENSION,
  async load(env, workspaceId) {
    const data = await loadPolicyData(env, workspaceId)
    const evaluators = new Map<string, (printerId: string) => readonly PrinterPermission[]>()
    return {
      permissions(principal, printerId) {
        const key = principalKey(principal)
        let evaluate = evaluators.get(key)
        if (!evaluate) {
          evaluate = evaluator(data, principal)
          evaluators.set(key, evaluate)
        }
        return evaluate(printerId)
      },
    }
  },
}
