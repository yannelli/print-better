import { Suspense } from 'react'
import { useActiveExtensions } from '@/hooks/extensions'
import { usePrinterRights } from '@/hooks/access'
import { useCanManage } from '@/hooks/workspace'
import { EXTENSION_UI } from './index'
import { activeUi, type ExtensionPage, type SlotEntry, type SlotName, type SlotProps, type UiId, slotEntries, visibleEntries, visiblePages } from './registry'

// The registry is a constant, so every render calls the same hooks in the same order.
const WITH_FEATURES = EXTENSION_UI.filter((ext) => ext.useFeatures)

function useFeatures(ws: string, active: ReadonlySet<UiId>): ReadonlySet<string> {
  const sets = WITH_FEATURES.map((ext) => ext.useFeatures!(ws, active.has(ext.id)))
  return new Set(sets.flatMap((set) => [...set]))
}

function useContextFor(ws: string) {
  const active = activeUi(useActiveExtensions(ws))
  return { active, rights: usePrinterRights(ws), canManage: useCanManage(), features: useFeatures(ws, active) }
}

/** Entries for `name` from active extensions that apply to these props. */
export function useSlot<K extends SlotName>(name: K, props: SlotProps[K]): SlotEntry<SlotProps[K]>[] {
  const ctx = useContextFor(props.ws)
  return visibleEntries(slotEntries(EXTENSION_UI, ctx.active, name), props, ctx)
}

/** Extension pages this caller can open in `ws`. */
export function usePages(ws: string): ExtensionPage[] {
  return visiblePages(EXTENSION_UI, useContextFor(ws))
}

export function SlotItem<P extends object>({ entry, props }: { entry: SlotEntry<P>; props: P }) {
  const { Component } = entry
  return (
    <Suspense fallback={null}>
      <Component {...props} />
    </Suspense>
  )
}

/** Renders every active extension's UI for a slot; nothing at all while none is active. */
export function Slot<K extends SlotName>({ name, props }: { name: K; props: SlotProps[K] }) {
  const entries = useSlot(name, props)
  return entries.map((entry) => <SlotItem key={entry.id} entry={entry} props={props} />)
}
