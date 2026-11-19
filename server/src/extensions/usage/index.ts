import { Gauge } from 'lucide-react'
import { lazy } from 'react'
import type { ExtensionUi } from '../registry'

/** Shared by Print rules and limits and Enterprise controls, active while either is (docs/usage.md). */
export const usageUi: ExtensionUi = {
  id: 'usage',
  slots: {
    settingsTab: [{ id: 'prices', label: 'Prices', Component: lazy(() => import('./settings-tab')) }],
    printForm: [{ id: 'usage', Component: lazy(() => import('./print-preview')) }],
    jobMeta: [{ id: 'usage', Component: lazy(() => import('./job-meta')) }],
  },
  pages: [
    {
      path: '/usage/:tab?',
      Component: lazy(() => import('./usage-page')),
      nav: { label: 'Usage', icon: Gauge, href: '/usage' },
      // Members see the limits that count their jobs; Enterprise controls' tabs are for admins.
      visible: ({ active, canManage }) => canManage || active.has('print-policies'),
    },
  ],
}
