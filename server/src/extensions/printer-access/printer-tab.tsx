import { useId } from 'react'
import { Link } from 'wouter'
import { NO_ACCESS, type PrinterAccess, type WorkspaceAccess } from '@shared/access'
import type { Printer } from '@shared/types'
import { Row, Section } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { QueryState } from '@/components/states'
import { useCanManage } from '@/hooks/workspace'
import { ChoiceSelect } from '@/routes/settings/fields'
import type { SlotProps } from '../registry'
import { CheckAccess } from './check-access'
import { GrantList, InheritedRow } from './grants'
import { usePrinterAccess, useSetEveryone, useWorkspaceAccess } from './hooks'
import { LAN_SHARE_WARNING, Note } from './note'
import { roleChoices, WORKSPACE_DEFAULT } from './roles'

function Everyone({ ws, printer, access, workspace }: { ws: string; printer: Printer; access: PrinterAccess; workspace: WorkspaceAccess }) {
  const id = useId()
  const set = useSetEveryone(ws, printer.id)
  const restricted = access.effectiveEveryoneRole === NO_ACCESS
  const current = access.everyoneRole ?? WORKSPACE_DEFAULT
  const options = roleChoices(workspace, { workspaceDefault: true, none: 'Only owners, admins, and the people below can use it' })
  return (
    <Section id="everyone" title="Everyone" description="What every member and device in this workspace can do with this printer." flush>
      <Row label="Everyone gets" htmlFor={`${id}-everyone`}>
        <ChoiceSelect
          id={`${id}-everyone`}
          value={current}
          onChange={(value) => value !== current && set.mutate(value === WORKSPACE_DEFAULT ? null : value)}
          options={options}
          disabled={set.isPending}
        />
      </Row>
      {restricted && (
        <Note tone="neutral">This printer is restricted. Only owners, admins, and the people, groups, and devices below can use it.</Note>
      )}
      {restricted && printer.settings.lanShare && <Note tone="warn">{LAN_SHARE_WARNING}</Note>}
    </Section>
  )
}

function Content({ ws, printer, access, workspace }: { ws: string; printer: Printer; access: PrinterAccess; workspace: WorkspaceAccess }) {
  const canManage = useCanManage()
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <Everyone ws={ws} printer={printer} access={access} workspace={workspace} />
      <Section
        id="grants"
        title="People, groups, and devices"
        description="Give someone more than Everyone gets. Access only adds up, so this never takes anything away."
        flush
      >
        <GrantList
          ws={ws}
          printerId={printer.id}
          grants={access.grants}
          access={workspace}
          canEdit
          empty="No one has been given extra access to this printer."
        />
      </Section>
      {access.inherited.length > 0 && (
        <Section
          id="inherited"
          title="From workspace settings"
          description={
            canManage ? (
              <>
                These apply to every printer.{' '}
                <Link href={wsHref(ws, '/settings/printer-access')} className="underline underline-offset-4 hover:text-foreground">
                  Change them in Workspace settings
                </Link>
                .
              </>
            ) : (
              'These apply to every printer. Workspace admins can change them.'
            )
          }
          flush
        >
          <ul>
            {access.inherited.map((g) => (
              <InheritedRow key={g.id} grant={g} access={workspace} />
            ))}
          </ul>
        </Section>
      )}
      <CheckAccess ws={ws} printerId={printer.id} access={workspace} />
    </div>
  )
}

export default function PrinterAccessTab({ ws, printer }: SlotProps['printerTab']) {
  const access = usePrinterAccess(ws, printer.id)
  const workspace = useWorkspaceAccess(ws)
  return (
    <QueryState query={access}>
      {(data) => <QueryState query={workspace}>{(wide) => <Content ws={ws} printer={printer} access={data} workspace={wide} />}</QueryState>}
    </QueryState>
  )
}
