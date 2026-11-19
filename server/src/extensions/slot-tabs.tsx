import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTab } from '@/routes/settings/use-tab'
import type { SlotProps } from './registry'
import { SlotItem, useSlot } from './slot'

type TabSlot = 'printerTab' | 'membersTab'

/** The page's own content, plus a tab per active extension entry. With none active, just the content, no tabs. */
export function SlotTabs<K extends TabSlot>({
  name,
  props,
  base,
  main,
  children,
}: {
  name: K
  props: SlotProps[K]
  /** Page path for `useTab`, without the tab, e.g. `w/abc/members`. */
  base: string
  main: { id: string; label: string }
  children: ReactNode
}) {
  const extra = useSlot(name, props)
  const [tab, setTab] = useTab(base, [main.id, ...extra.map((t) => t.id)])
  if (extra.length === 0) return <>{children}</>
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as string)} className="gap-8">
      <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
        <TabsTrigger value={main.id}>{main.label}</TabsTrigger>
        {extra.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={main.id}>{children}</TabsContent>
      {extra.map((t) => (
        <TabsContent key={t.id} value={t.id}>
          <SlotItem entry={t} props={props} />
        </TabsContent>
      ))}
    </Tabs>
  )
}
