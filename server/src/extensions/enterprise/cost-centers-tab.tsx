import { Landmark, Plus } from 'lucide-react'
import { useState } from 'react'
import type { CostCenter } from '@shared/enterprise'
import { Confirm } from '@/components/confirm'
import { Mono, Section } from '@/components/page'
import { EmptyState, QueryState } from '@/components/states'
import { StatusPill } from '@/components/status'
import { Button } from '@/components/ui/button'
import type { SlotProps } from '../registry'
import { enterpriseApi } from './api'
import { CostCenterDialog } from './cost-center-dialog'
import { DefaultsSection } from './defaults-section'
import { useCostCenters, useEnterpriseMutation } from './hooks'

function CenterRow({ ws, center, onEdit }: { ws: string; center: CostCenter; onEdit: () => void }) {
  const remove = useEnterpriseMutation(ws, () => enterpriseApi.deleteCostCenter(ws, center.id), 'Cost center deleted')
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-medium">
          {center.name}
          {!center.active && <StatusPill status={{ label: 'Inactive', tone: 'neutral' }} />}
        </span>
        {center.code && <Mono className="text-sm text-muted-foreground">{center.code}</Mono>}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Confirm
          trigger={
            <Button variant="ghost" size="sm">
              Delete
            </Button>
          }
          title={`Delete ${center.name}?`}
          description="Only cost centers no job was charged to can be deleted. To keep history, make it inactive instead."
          confirmLabel="Delete"
          destructive
          onConfirm={() => remove.mutateAsync(undefined)}
        />
      </div>
    </li>
  )
}

/** Usage > Cost centers (admins): the list, then who is charged to which by default. */
export default function CostCentersTab({ ws }: SlotProps['usageTab']) {
  const list = useCostCenters(ws)
  const [editing, setEditing] = useState<{ center?: CostCenter } | null>(null)
  const add = (
    <Button onClick={() => setEditing({})}>
      <Plus data-icon="inline-start" />
      New cost center
    </Button>
  )
  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <QueryState query={list}>
        {({ costCenters }) =>
          costCenters.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No cost centers yet"
              description="Add departments, projects, or clients, then charge each job to one. Budgets and reports follow."
              action={add}
            />
          ) : (
            <>
              <Section
                id="cost-centers"
                title="Cost centers"
                description="People choose one when they print, or jobs use their default below."
                actions={add}
                flush
              >
                <ul>
                  {costCenters.map((center) => (
                    <CenterRow key={center.id} ws={ws} center={center} onEdit={() => setEditing({ center })} />
                  ))}
                </ul>
              </Section>
              <DefaultsSection ws={ws} centers={costCenters} />
            </>
          )
        }
      </QueryState>
      {editing && <CostCenterDialog key={editing.center?.id ?? 'new'} ws={ws} center={editing.center} onOpenChange={(open) => !open && setEditing(null)} />}
    </div>
  )
}
