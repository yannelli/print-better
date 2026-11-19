import type { LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import type { ExtensionId } from '@shared/extensions'
import type { Client, Job, JobOptions, Printer, Workspace } from '@shared/types'
import { USAGE_EXTENSIONS } from '@shared/usage'
import type { PrinterRights } from '@/lib/access'

/** What the print dialog is about to send. */
export interface PrintDraft {
  printerId: string
  /** The job's own options, without the printer's defaults. */
  options: JobOptions
  /** The chosen file, or the typed text as a text file; null until there is something to print. */
  document: File | null
}

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
  /** A tab on Workspace settings, before Extensions. */
  settingsTab: { ws: string; workspace: Workspace }
  /** A section on a device's page. */
  deviceSection: { ws: string; client: Client }
  /** In the print dialog, under the options. `setExtra` adds fields such as `costCenter` to the job request and its previews. */
  printForm: { ws: string; draft: PrintDraft; extra: Readonly<Record<string, unknown>>; setExtra: (fields: Record<string, unknown>) => void }
  /** Under each job in Print jobs. */
  jobMeta: { ws: string; job: Job }
  /** A compact card on Home, under the printers. */
  homeSection: { ws: string }
  /** A tab on the Usage page. */
  usageTab: { ws: string }
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

/** An extension, or `usage`: the UI shared by Print rules and limits and Enterprise controls, active while either is. */
export type UiId = ExtensionId | 'usage'

export interface PageContext extends SlotContext {
  active: ReadonlySet<UiId>
}

/** A page under /w/:ws, with an optional entry in the navigation. */
export interface ExtensionPage {
  /** A route pattern under /w/:ws, e.g. `/usage/:tab?`. */
  path: string
  Component: ComponentType
  nav?: { label: string; icon: LucideIcon; href: string }
  visible?: (ctx: PageContext) => boolean
}

export interface ExtensionUi {
  id: UiId
  slots: { [K in SlotName]?: SlotEntry<SlotProps[K]>[] }
  pages?: ExtensionPage[]
}

/** The UI ids in effect: the active extensions, plus `usage` while either usage extension is. */
export function activeUi(active: ReadonlySet<ExtensionId>): ReadonlySet<UiId> {
  return USAGE_EXTENSIONS.some((id) => active.has(id)) ? new Set<UiId>([...active, 'usage']) : active
}

/** The entries for one slot from the extensions that are active, in registry order. */
export function slotEntries<K extends SlotName>(registry: readonly ExtensionUi[], active: ReadonlySet<UiId>, name: K): SlotEntry<SlotProps[K]>[] {
  return registry.filter((ext) => active.has(ext.id)).flatMap((ext) => ext.slots[name] ?? [])
}

/** Pages of active extensions that show for this caller, in registry order. */
export function visiblePages(registry: readonly ExtensionUi[], ctx: PageContext): ExtensionPage[] {
  return registry.filter((ext) => ctx.active.has(ext.id)).flatMap((ext) => (ext.pages ?? []).filter((page) => !page.visible || page.visible(ctx)))
}

/** Entries that should show for these props. */
export function visibleEntries<P>(entries: SlotEntry<P>[], props: P, ctx: SlotContext): SlotEntry<P>[] {
  return entries.filter((entry) => !entry.visible || entry.visible(props, ctx))
}
