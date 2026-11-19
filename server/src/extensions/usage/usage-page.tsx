import { Gauge } from 'lucide-react'
import { PageHeader } from '@/components/page'
import { EmptyState } from '@/components/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCanManage, useWs } from '@/hooks/workspace'
import { useTab } from '@/routes/settings/use-tab'
import { SlotItem, useSlot } from '../slot'

/** /w/:ws/usage/:tab?: one tab per `usageTab` entry, without a tab bar when there is only one. */
export default function UsagePage() {
  const ws = useWs()
  const props = { ws }
  const tabs = useSlot('usageTab', props)
  const [tab, setTab] = useTab(
    `w/${ws}/usage`,
    tabs.map((t) => t.id),
  )
  const description = useCanManage() ? 'What is printed in this workspace, and the limits and rules every job goes through.' : 'What you have printed, and what is left.'
  return (
    <>
      <PageHeader title="Usage" description={description} />
      {tabs.length === 0 ? (
        <EmptyState icon={Gauge} title="Nothing here yet" description="Usage shows up here once limits are set." />
      ) : tabs.length === 1 ? (
        <SlotItem entry={tabs[0]} props={props} />
      ) : (
        <Tabs value={tab} onValueChange={(value) => setTab(value as string)} className="gap-8">
          <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
            {tabs.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.id} value={t.id} className="flex flex-col gap-10">
              <SlotItem entry={t} props={props} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </>
  )
}
