import type { CronHook, ExtensionOffHook, JobFinishHook, JobViewHook } from '../hooks'
import { alertSettled } from './alerts'
import { cancelAllHeld, sweepHeld } from './held-sweep'
import { deleteFinished, privacyView } from './privacy'
import { sendDueReports } from './send-reports'
import { loadSettings } from './store'

// Only extensions/hooks.ts imports this file, so these objects are built once its imports have loaded.

/** Retention first, then alerts for what printers reported. */
export const enterpriseFinish: JobFinishHook = {
  extension: 'enterprise',
  finished: async (ctx, workspaceId, jobs) => {
    await deleteFinished(ctx, workspaceId, jobs)
    await alertSettled(ctx, workspaceId, jobs)
  },
}

export const enterpriseView: JobViewHook = {
  extension: 'enterprise',
  load: async (env, workspaceId) => privacyView(await loadSettings(env, workspaceId)),
}

export const enterpriseOff: ExtensionOffHook = { extension: 'enterprise', turnedOff: (ctx, workspaceIds) => cancelAllHeld(ctx, workspaceIds) }

export const enterpriseCron: CronHook = {
  name: 'enterprise',
  run: async (env) => {
    await sweepHeld(env)
    await sendDueReports(env)
  },
}
