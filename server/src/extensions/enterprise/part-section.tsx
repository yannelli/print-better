import { type ReactNode, useState } from 'react'
import type { EnterpriseSettings } from '@shared/enterprise'
import { Row, Section } from '@/components/page'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useUpdateEnterprise } from './hooks'
import { PARTS, type Part } from './words'

export interface PartProps {
  ws: string
  settings: EnterpriseSettings
  canEdit: boolean
}

/** One part's card: its on switch first, then its own settings. `offWarning` asks before turning it off. */
export function PartSection({ ws, part, settings, canEdit, offWarning, children }: PartProps & { part: Part; offWarning?: string; children?: ReactNode }) {
  const update = useUpdateEnterprise(ws)
  const [asking, setAsking] = useState(false)
  const { label, summary } = PARTS.find((p) => p.id === part)!
  const id = `enterprise-${part}`
  const set = (enabled: boolean) => update.mutate({ [part]: { enabled } }, { onSuccess: () => setAsking(false) })
  return (
    <Section id={id} title={label} description={summary} flush>
      <Row label={`Turn on ${label.toLowerCase()}`} htmlFor={`${id}-on`} description={settings[part].enabled ? 'On' : 'Off. Nothing changes until you turn it on.'}>
        <Switch
          id={`${id}-on`}
          checked={settings[part].enabled}
          onCheckedChange={(enabled) => (!enabled && offWarning ? setAsking(true) : set(enabled))}
          disabled={!canEdit || update.isPending}
        />
      </Row>
      {children}
      {offWarning && (
        <AlertDialog open={asking} onOpenChange={(open) => !open && !update.isPending && setAsking(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Turn off {label.toLowerCase()}?</AlertDialogTitle>
              <AlertDialogDescription>{offWarning}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={update.isPending}>Cancel</AlertDialogCancel>
              <Button variant="destructive" onClick={() => set(false)} disabled={update.isPending}>
                {update.isPending && <Spinner data-icon="inline-start" />}
                Turn off
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Section>
  )
}
