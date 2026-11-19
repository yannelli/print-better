import { lazy } from 'react'
import type { ExtensionUi, SlotContext } from '../registry'
import { useEnterpriseFeatures } from './hooks'
import { isApprover, type Part } from './words'

const on = (ctx: SlotContext, part: Part) => !!ctx.features?.has(`enterprise.${part}`)
const forAdmins = (part: Part) => (_props: unknown, ctx: SlotContext) => ctx.canManage && on(ctx, part)
const whenOn = (part: Part) => (_props: unknown, ctx: SlotContext) => on(ctx, part)

/** Each entry shows only while its part is switched on (docs/enterprise.md). */
export const enterpriseUi: ExtensionUi = {
  id: 'enterprise',
  useFeatures: useEnterpriseFeatures,
  slots: {
    settingsTab: [{ id: 'enterprise', label: 'Enterprise', Component: lazy(() => import('./settings-tab')) }],
    printerTab: [
      {
        id: 'controls',
        label: 'Approval and release',
        Component: lazy(() => import('./printer-tab')),
        visible: ({ printer }, ctx) => ctx.rights.can(printer.id, 'settings') && (on(ctx, 'approvals') || on(ctx, 'release')),
      },
    ],
    printerBadge: [{ id: 'controls', Component: lazy(() => import('./printer-badge')) }],
    jobsTab: [
      { id: 'approvals', label: 'Approvals', Component: lazy(() => import('./approvals-tab')), visible: (_p, ctx) => on(ctx, 'approvals') && isApprover(ctx.rights) },
      { id: 'release', label: 'Ready to release', Component: lazy(() => import('./release-tab')), visible: whenOn('release') },
    ],
    jobActions: [{ id: 'holds', Component: lazy(() => import('./job-actions')) }],
    jobMeta: [{ id: 'cost-center', Component: lazy(() => import('./job-meta')), visible: whenOn('costCenters') }],
    homeSection: [{ id: 'enterprise', Component: lazy(() => import('./home-section')) }],
    printForm: [{ id: 'cost-center', Component: lazy(() => import('./cost-center-picker')), visible: whenOn('costCenters') }],
    usageTab: [
      { id: 'cost-centers', label: 'Cost centers', Component: lazy(() => import('./cost-centers-tab')), visible: forAdmins('costCenters') },
      { id: 'budgets', label: 'Budgets', Component: lazy(() => import('./budgets-tab')), visible: forAdmins('costCenters') },
      { id: 'reports', label: 'Reports', Component: lazy(() => import('./reports-tab')), visible: forAdmins('reports') },
    ],
    deviceSection: [{ id: 'cost-center', Component: lazy(() => import('./device-section')), visible: forAdmins('costCenters') }],
  },
}
