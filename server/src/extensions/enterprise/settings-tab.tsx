import { type ComponentType, useState } from 'react'
import type { EnterpriseSettings } from '@shared/enterprise'
import { QueryState } from '@/components/states'
import { StatusDot } from '@/components/status'
import { useCanManage, useRole } from '@/hooks/workspace'
import { cn } from '@/lib/utils'
import type { SlotProps } from '../registry'
import { useEnterprise } from './hooks'
import type { PartProps } from './part-section'
import { ApprovalsPart, CostCentersPart, ReleasePart, ReportsPart } from './settings-parts'
import { AlertsPart, PrivacyPart } from './settings-people'
import { PARTS, type Part } from './words'

const PANELS: Record<Part, ComponentType<PartProps>> = {
  approvals: ApprovalsPart,
  release: ReleasePart,
  costCenters: CostCentersPart,
  reports: ReportsPart,
  alerts: AlertsPart,
  privacy: PrivacyPart,
}

/** The part named in the URL's hash, so links can open one. */
function partInUrl(): Part {
  const hash = location.hash.slice(1)
  return PARTS.find((p) => p.id === hash)?.id ?? 'approvals'
}

/** Phones get a row of chips that scrolls sideways; wider screens a list beside the part. */
function PartNav({ settings, part, onSelect }: { settings: EnterpriseSettings; part: Part; onSelect: (part: Part) => void }) {
  return (
    <nav aria-label="Parts of Enterprise controls" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:w-60 lg:shrink-0 lg:overflow-visible lg:px-0">
      <ul className="flex w-max gap-2 lg:w-full lg:flex-col lg:gap-1">
        {PARTS.map(({ id, label }) => {
          const on = settings[id].enabled
          return (
            <li key={id}>
              <button
                type="button"
                aria-current={id === part ? 'true' : undefined}
                onClick={() => onSelect(id)}
                className={cn(
                  'press flex h-11 w-full items-center gap-2.5 rounded-full border px-4 text-[0.9375rem] font-medium whitespace-nowrap text-foreground/70 hover:bg-muted hover:text-foreground lg:rounded-2xl lg:border-transparent',
                  id === part && 'border-foreground/15 bg-muted text-foreground',
                )}
              >
                <StatusDot tone={on ? 'ok' : 'neutral'} />
                <span className="flex-1 text-left">{label}</span>
                <span className="text-sm font-normal text-muted-foreground">{on ? 'On' : 'Off'}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** Workspace settings > Enterprise: one part at a time, each with its own switch. */
export default function EnterpriseSettingsTab({ ws }: SlotProps['settingsTab']) {
  const config = useEnterprise(ws)
  const canManage = useCanManage()
  const isOwner = useRole() === 'owner'
  const [part, setPart] = useState<Part>(partInUrl)
  const select = (next: Part) => {
    setPart(next)
    history.replaceState(history.state, '', `#${next}`)
  }
  const Panel = PANELS[part]
  return (
    <QueryState query={config}>
      {({ settings }) => (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
          <PartNav settings={settings} part={part} onSelect={select} />
          <div className="flex max-w-3xl min-w-0 flex-1 flex-col gap-8">
            <Panel key={part} ws={ws} settings={settings} canEdit={part === 'privacy' ? isOwner : canManage} />
          </div>
        </div>
      )}
    </QueryState>
  )
}
