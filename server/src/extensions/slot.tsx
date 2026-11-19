import { Suspense } from 'react'
import { useActiveExtensions } from '@/hooks/extensions'
import { usePrinterRights } from '@/hooks/access'
import { useCanManage } from '@/hooks/workspace'
import { EXTENSION_UI } from './index'
import { type SlotEntry, type SlotName, type SlotProps, slotEntries, visibleEntries } from './registry'

/** Entries for `name` from active extensions that apply to these props. */
export function useSlot<K extends SlotName>(name: K, props: SlotProps[K]): SlotEntry<SlotProps[K]>[] {
  const active = useActiveExtensions(props.ws)
  const rights = usePrinterRights(props.ws)
  const canManage = useCanManage()
  return visibleEntries(slotEntries(EXTENSION_UI, active, name), props, { rights, canManage })
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
