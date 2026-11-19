import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { PrinterRole, WorkspaceAccess } from '@shared/access'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { permissionSummary } from '@/lib/words'
import { useDeleteRole } from './hooks'
import { RoleDialog } from './role-dialog'

function RoleRow({ ws, role, canEdit, onEdit }: { ws: string; role: PrinterRole; canEdit: boolean; onEdit: () => void }) {
  const remove = useDeleteRole(ws)
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-medium">
          {role.name}
          {role.builtIn && <span className="font-normal text-muted-foreground">(built in)</span>}
        </span>
        {role.description && <span className="text-sm text-muted-foreground">{role.description}</span>}
        <span className="text-sm text-muted-foreground">{permissionSummary(role.permissions)}</span>
      </div>
      {canEdit && !role.builtIn && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil data-icon="inline-start" />
            Edit
          </Button>
          <Confirm
            trigger={
              <Button variant="ghost" size="sm">
                <Trash2 data-icon="inline-start" />
                Delete
              </Button>
            }
            title={`Delete the ${role.name} role?`}
            description="A role can only be deleted when nothing uses it: no one has it, and no printer or the workspace default gives it to Everyone."
            confirmLabel="Delete role"
            destructive
            onConfirm={() => remove.mutateAsync(role.id)}
          />
        </div>
      )}
    </li>
  )
}

export function RolesSection({ ws, access, canEdit }: { ws: string; access: WorkspaceAccess; canEdit: boolean }) {
  const [editing, setEditing] = useState<{ role?: PrinterRole } | null>(null)
  return (
    <Section
      id="printer-roles"
      title="Printer roles"
      description="Each role is a set of things people can do with a printer. Make your own when the built-in ones don’t fit."
      actions={
        canEdit && (
          <Button variant="outline" onClick={() => setEditing({})}>
            <Plus data-icon="inline-start" />
            New role
          </Button>
        )
      }
      flush
    >
      <ul>
        {access.roles.map((role) => (
          <RoleRow key={role.id} ws={ws} role={role} canEdit={canEdit} onEdit={() => setEditing({ role })} />
        ))}
      </ul>
      {editing && (
        <RoleDialog
          key={editing.role?.id ?? 'new'}
          ws={ws}
          role={editing.role}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </Section>
  )
}
