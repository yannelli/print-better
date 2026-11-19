import { lazy } from 'react'
import type { ExtensionUi } from '../registry'

const admins = (_props: unknown, { canManage }: { canManage: boolean }) => canManage

/** Tabs on the shared Usage page and a card on Home; loaded only where the extension is on. */
export const printPoliciesUi: ExtensionUi = {
  id: 'print-policies',
  slots: {
    usageTab: [
      { id: 'overview', label: 'Overview', Component: lazy(() => import('./overview-tab')) },
      { id: 'limits', label: 'Limits', Component: lazy(() => import('./limits-tab')), visible: admins },
      { id: 'rules', label: 'Rules', Component: lazy(() => import('./rules-tab')), visible: admins },
    ],
    homeSection: [{ id: 'my-limits', Component: lazy(() => import('./home-card')) }],
  },
}
