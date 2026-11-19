import { BUILT_IN_ROLES, PRINTER_PERMISSIONS, type PrinterPermission, withImplied } from '@shared/access'
import { Badge } from '@/components/ui/badge'
import { joinAnd, PERMISSION_WORDS } from '@/lib/access-words'

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

function includes(permission: PrinterPermission): string | null {
  const implied = withImplied([permission]).filter((p) => p !== permission)
  return implied.length ? `Includes ${joinAnd(implied.map((p) => PERMISSION_WORDS[p].label))}.` : null
}

/** The printer-access permissions, worded as the app shows them. */
export function PermissionTable() {
  return (
    <table className="docs-stack">
      <thead>
        <tr>
          <th>Permission</th>
          <th>What it allows</th>
          <th>API name</th>
        </tr>
      </thead>
      <tbody>
        {PRINTER_PERMISSIONS.map((permission) => (
          <tr key={permission}>
            <td>{PERMISSION_WORDS[permission].label}</td>
            <td data-label="What it allows">
              {sentence(PERMISSION_WORDS[permission].help)} {includes(permission)}
            </td>
            <td data-label="API name">
              <code>{permission}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The built-in printer-access roles and the permissions each one has. */
export function RoleTable() {
  return (
    <table className="docs-stack">
      <thead>
        <tr>
          <th>Role</th>
          <th>What it can do</th>
          <th>Permissions</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(BUILT_IN_ROLES).map(([id, role]) => (
          <tr key={id}>
            <td>{role.name}</td>
            <td data-label="What it can do">{sentence(role.description)}</td>
            <td data-label="Permissions">
              <span className="flex flex-wrap gap-1.5">
                {role.permissions.map((permission) => (
                  <Badge key={permission} variant="outline" className="h-auto min-h-5 whitespace-normal">
                    {PERMISSION_WORDS[permission].label}
                  </Badge>
                ))}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
