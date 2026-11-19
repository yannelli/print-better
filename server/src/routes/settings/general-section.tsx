import type { Workspace } from '@shared/types'
import { Row, Section } from '@/components/page'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useAddedPrinters } from '@/hooks/printers'
import { useUpdateWorkspace } from '@/hooks/workspace'
import { useDraft } from './draft'
import { ChoiceSelect, SaveBar } from './fields'

const ASK = 'ask'

export function GeneralSection({ workspace, canManage }: { workspace: Workspace; canManage: boolean }) {
  const printers = useAddedPrinters(workspace.id).data ?? []
  const update = useUpdateWorkspace(workspace.id)
  const { draft, dirty, set, reset, changes } = useDraft({
    name: workspace.name,
    defaultPrinterId: workspace.settings.defaultPrinterId ?? ASK,
  })
  const nameMissing = !draft.name.trim()

  const save = () => {
    const c = changes()
    update.mutate({
      ...(c.name !== undefined && { name: c.name.trim() }),
      ...(c.defaultPrinterId !== undefined && {
        settings: { defaultPrinterId: c.defaultPrinterId === ASK ? null : c.defaultPrinterId },
      }),
    })
  }

  const printerChoices = [
    { value: ASK, label: 'Ask each time' },
    ...printers.map((p) => ({ value: p.id, label: p.name })),
  ]

  return (
    <Section id="general" flush>
      <Row label="Workspace name" htmlFor="ws-name" description="Shown in the menu and on invites.">
        <div className="flex w-full flex-col gap-1.5 sm:w-64">
          <Input
            id="ws-name"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            disabled={!canManage}
            maxLength={80}
            aria-invalid={nameMissing || undefined}
          />
          {nameMissing && <FieldError>Give the workspace a name.</FieldError>}
        </div>
      </Row>
      <Row label="Default printer" htmlFor="ws-default-printer" description="Used when someone prints without picking a printer.">
        <ChoiceSelect
          id="ws-default-printer"
          value={draft.defaultPrinterId}
          onChange={(defaultPrinterId) => set({ defaultPrinterId })}
          options={printerChoices}
          disabled={!canManage}
        />
      </Row>
      {canManage && <SaveBar dirty={dirty} pending={update.isPending} onSave={save} onReset={reset} disabled={nameMissing} />}
    </Section>
  )
}
