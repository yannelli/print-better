import type { ComponentType } from 'react'
import type { ExtensionId } from '@shared/extensions'
import type { Client, Printer, Workspace } from '@shared/types'
import type { PrinterRights } from '@/lib/access'

/** Places in the core screens where an extension can add UI, and the props each one receives. */
export interface SlotProps {
  /** A tab next to the printer's overview. */
  printerTab: { ws: string; printer: Printer }
  /** Small marks beside a printer's name in cards and headers. */
  printerBadge: { ws: string; printer: Printer }
  /** Notes under the printer's local network sharing switch. */
  printerSharingNote: { ws: string; printer: Printer }
  /** A tab next to People on the Members page. */
  membersTab: { ws: string }
  /** A section on Workspace settings, after the core ones. */
  settingsSection: { ws: string; workspace: Workspace }
  /** A section on a device's page. */
  deviceSection: { ws: string; client: Client }
}

export type SlotName = keyof SlotProps

export interface SlotContext {
  rights: PrinterRights
  /** Workspace owner or admin. */
  canManage: boolean
}

export interface SlotEntry<P> {
  /** Unique within the slot; tabs use it in the URL. */
  id: string
  Component: ComponentType<P>
  /** Tab slots: the tab's name. */
  label?: string
  visible?: (props: P, ctx: SlotContext) => boolean
}

export interface ExtensionUi {
  id: ExtensionId
  slots: { [K in SlotName]?: SlotEntry<SlotProps[K]>[] }
}

/** The entries for one slot from the extensions that are active, in registry order. */
export function slotEntries<K extends SlotName>(
  registry: readonly ExtensionUi[],
  active: ReadonlySet<ExtensionId>,
  name: K,
): SlotEntry<SlotProps[K]>[] {
  return registry.filter((ext) => active.has(ext.id)).flatMap((ext) => ext.slots[name] ?? [])
}

/** Entries that should show for these props. */
export function visibleEntries<P>(entries: SlotEntry<P>[], props: P, ctx: SlotContext): SlotEntry<P>[] {
  return entries.filter((entry) => !entry.visible || entry.visible(props, ctx))
}
