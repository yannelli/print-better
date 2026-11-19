import { useId } from 'react'
import { Row, Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Switch } from '@/components/ui/switch'
import type { SlotProps } from '../registry'
import { useEnterprise, useSetControls } from './hooks'

const OFF = { approval: false, secureRelease: false }

/** A printer's approval and secure release switches; each shows while its part is on. */
export default function PrinterControlsTab({ ws, printer }: SlotProps['printerTab']) {
  const id = useId()
  const config = useEnterprise(ws)
  const set = useSetControls(ws, printer.id)
  return (
    <QueryState query={config}>
      {({ settings, printers }) => {
        const controls = printers[printer.id] ?? OFF
        return (
          <div className="flex max-w-3xl flex-col gap-8">
            <Section
              id="printer-controls"
              title="Approval and release"
              description="Rules can also ask for these on some jobs only. Jobs already waiting keep waiting when you change a switch."
              flush
            >
              {settings.approvals.enabled && (
                <Row
                  label="Every job needs approval"
                  htmlFor={`${id}-approval`}
                  description="Jobs wait until an owner, an admin, or someone who manages this printer’s jobs approves them."
                >
                  <Switch id={`${id}-approval`} checked={controls.approval} onCheckedChange={(approval) => set.mutate({ approval })} disabled={set.isPending} />
                </Row>
              )}
              {settings.release.enabled && (
                <Row
                  label="Hold jobs until released"
                  htmlFor={`${id}-release`}
                  description="Each job waits until the person who sent it releases it, for example from their phone at the printer."
                >
                  <Switch
                    id={`${id}-release`}
                    checked={controls.secureRelease}
                    onCheckedChange={(secureRelease) => set.mutate({ secureRelease })}
                    disabled={set.isPending}
                  />
                </Row>
              )}
            </Section>
          </div>
        )
      }}
    </QueryState>
  )
}
