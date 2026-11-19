import { lazy } from 'react'
import type { ExtensionUi } from '../registry'

/** Loaded on demand, so workspaces without printer access never download this UI. */
export const printerAccessUi: ExtensionUi = {
  id: 'printer-access',
  slots: {
    printerTab: [
      {
        id: 'access',
        label: 'Access',
        Component: lazy(() => import('./printer-tab')),
        visible: ({ printer }, { rights }) => rights.can(printer.id, 'access'),
      },
    ],
    printerBadge: [{ id: 'restricted', Component: lazy(() => import('./restricted-badge')) }],
    printerSharingNote: [{ id: 'lan-restricted', Component: lazy(() => import('./lan-share-note')) }],
    membersTab: [{ id: 'groups', label: 'Groups', Component: lazy(() => import('./groups-tab')) }],
    settingsSection: [{ id: 'printer-access', Component: lazy(() => import('./settings-section')) }],
    deviceSection: [
      { id: 'printer-access', Component: lazy(() => import('./device-section')), visible: (_props, { canManage }) => canManage },
    ],
  },
}
