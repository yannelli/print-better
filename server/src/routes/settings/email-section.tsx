import type { Workspace } from '@shared/types'
import { Row, Section } from '@/components/page'
import { FieldDescription, FieldError } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useInstance } from '@/hooks/auth'
import { useUpdateWorkspace } from '@/hooks/workspace'
import { useDraft } from './draft'
import { Block, SaveBar } from './fields'

const parseList = (text: string) =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)

const looksValid = (entry: string) => /^@[^\s@]+\.[^\s@]+$/.test(entry) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry)

export function EmailSection({ workspace, canManage }: { workspace: Workspace; canManage: boolean }) {
  const instance = useInstance().data
  const update = useUpdateWorkspace(workspace.id)
  const email = workspace.settings.emailToPrint
  const { draft, dirty, set, reset } = useDraft({
    enabled: email.enabled,
    allowMembers: email.allowMembers,
    allowlist: email.allowlist.join('\n'),
  })
  const invalid = parseList(draft.allowlist).filter((entry) => !looksValid(entry))

  const save = () => {
    const allowlist = parseList(draft.allowlist)
    update.mutate({
      settings: {
        emailToPrint: {
          ...(draft.enabled !== email.enabled && { enabled: draft.enabled }),
          ...(draft.allowMembers !== email.allowMembers && { allowMembers: draft.allowMembers }),
          ...(allowlist.join('\n') !== email.allowlist.join('\n') && { allowlist }),
        },
      },
    })
  }

  return (
    <Section
      id="email"
      title="Email to print"
      description="Let people print by emailing a document to a printer’s own address. Each printer’s address is set on its page."
      flush
    >
      {instance && !instance.emailEnabled && (
        <Block>
          <p className="text-[0.9375rem] text-muted-foreground">
            Incoming email isn’t set up on this server yet. A server admin can turn it on under Server admin, Email.
          </p>
        </Block>
      )}
      <Row label="Allow printing by email" htmlFor="ws-email-enabled">
        <Switch
          id="ws-email-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
          disabled={!canManage}
        />
      </Row>
      <Row
        label="Accept email from members"
        htmlFor="ws-email-members"
        description="Anyone in this workspace can print from the email address on their account."
      >
        <Switch
          id="ws-email-members"
          checked={draft.allowMembers}
          onCheckedChange={(allowMembers) => set({ allowMembers })}
          disabled={!canManage || !draft.enabled}
        />
      </Row>
      <Block>
        <label htmlFor="ws-email-allowlist" className="text-[0.9375rem] font-medium">
          Also accept email from
        </label>
        <Textarea
          id="ws-email-allowlist"
          value={draft.allowlist}
          onChange={(e) => set({ allowlist: e.target.value })}
          disabled={!canManage || !draft.enabled}
          placeholder={'grandpa@example.com\n@family.example'}
          rows={4}
          aria-invalid={invalid.length > 0 || undefined}
          aria-describedby="ws-email-allowlist-help"
          className="min-h-28 font-mono text-sm"
        />
        <FieldDescription id="ws-email-allowlist-help">
          One address per line. Start a line with @ to allow a whole domain.
        </FieldDescription>
        {invalid.length > 0 && <FieldError>These don’t look like email addresses: {invalid.join(', ')}</FieldError>}
      </Block>
      {canManage && (
        <SaveBar dirty={dirty} pending={update.isPending} onSave={save} onReset={reset} disabled={invalid.length > 0} />
      )}
    </Section>
  )
}
