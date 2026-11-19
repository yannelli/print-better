import type { WorkspaceAccess } from '@shared/access'
import { Row, Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { useCanManage } from '@/hooks/workspace'
import { roleName } from '@/lib/words'
import { ChoiceSelect } from '@/routes/settings/fields'
import type { SlotProps } from '../registry'
import { GrantList } from './grants'
import { useSetDefaultRole, useWorkspaceAccess } from './hooks'
import { RolesSection } from './roles-section'
import { roleChoices } from './roles'

function DefaultRole({ ws, access, canEdit }: { ws: string; access: WorkspaceAccess; canEdit: boolean }) {
  const set = useSetDefaultRole(ws)
  return (
    <Section
      id="printer-access"
      title="Printer access"
      description="Who can see, print to, and manage each printer. Owners and admins can always use every printer."
      flush
    >
      <Row
        label="Everyone gets"
        htmlFor="access-default-role"
        description="For every printer that doesn’t choose its own. Change a single printer on its Access tab."
      >
        {canEdit ? (
          <ChoiceSelect
            id="access-default-role"
            value={access.defaultRole}
            onChange={(role) => role !== access.defaultRole && set.mutate(role)}
            options={roleChoices(access, { none: 'Every printer is restricted unless it chooses otherwise' })}
            disabled={set.isPending}
          />
        ) : (
          <span className="text-[0.9375rem] text-muted-foreground">{roleName(access.defaultRole, access.roles)}</span>
        )}
      </Row>
    </Section>
  )
}

export default function PrinterAccessSettings({ ws }: SlotProps['settingsSection']) {
  const access = useWorkspaceAccess(ws)
  const canEdit = useCanManage()
  return (
    <QueryState query={access}>
      {(data) => (
        <>
          <DefaultRole ws={ws} access={data} canEdit={canEdit} />
          <RolesSection ws={ws} access={data} canEdit={canEdit} />
          <Section
            id="every-printer"
            title="Access to every printer"
            description="Give a person, group, or device a role on every printer in this workspace, including ones added later."
            flush
          >
            <GrantList
              ws={ws}
              printerId={null}
              grants={data.grants}
              access={data}
              canEdit={canEdit}
              empty="No one has been given access to every printer."
            />
          </Section>
        </>
      )}
    </QueryState>
  )
}
