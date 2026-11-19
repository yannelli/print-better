import { Row } from '@/components/page'
import { Switch } from '@/components/ui/switch'
import { useExtensionActive } from '@/hooks/extensions'
import { useDraft } from '@/routes/settings/draft'
import { Block, ChoiceSelect, SaveBar } from '@/routes/settings/fields'
import { useUpdateEnterprise } from './hooks'
import { MemberPicker } from './member-picker'
import { PartSection, type PartProps } from './part-section'

type Who = 'admins' | 'chosen'

function Recipients({ ws, recipients, canEdit }: { ws: string; recipients: string[] | null; canEdit: boolean }) {
  const update = useUpdateEnterprise(ws)
  const { draft, dirty, set, reset } = useDraft({ who: (recipients ? 'chosen' : 'admins') as Who, ids: recipients ?? [] })
  const invalid = draft.who === 'chosen' && draft.ids.length === 0
  return (
    <>
      <Row label="Admin alerts go to" htmlFor="enterprise-alert-who">
        <ChoiceSelect
          id="enterprise-alert-who"
          value={draft.who}
          onChange={(who) => set({ who })}
          options={[
            { value: 'admins', label: 'Every owner and admin' },
            { value: 'chosen', label: 'People I choose' },
          ]}
          disabled={!canEdit}
        />
      </Row>
      {draft.who === 'chosen' && (
        <Block>
          <MemberPicker id="enterprise-alert-people" ws={ws} value={draft.ids} onChange={(ids) => set({ ids })} disabled={!canEdit} />
          <span className="text-sm text-muted-foreground">Only people with an email address get alerts.</span>
        </Block>
      )}
      {canEdit && dirty && (
        <SaveBar
          dirty={dirty}
          pending={update.isPending}
          disabled={invalid}
          onReset={reset}
          onSave={() => update.mutate({ alerts: { recipients: draft.who === 'chosen' ? draft.ids : null } })}
        />
      )}
    </>
  )
}

export function AlertsPart({ ws, settings, canEdit }: PartProps) {
  const update = useUpdateEnterprise(ws)
  const { alerts } = settings
  const limits = useExtensionActive(ws, 'print-policies')
  return (
    <PartSection ws={ws} part="alerts" settings={settings} canEdit={canEdit}>
      {limits && (
        <Row
          label="Email people about their own limits"
          htmlFor="enterprise-alert-personal"
          description="At 80% and 100% of a limit that counts their jobs. They also see a note on Home."
        >
          <Switch
            id="enterprise-alert-personal"
            checked={alerts.personal}
            onCheckedChange={(personal) => update.mutate({ alerts: { personal } })}
            disabled={!canEdit || update.isPending}
          />
        </Row>
      )}
      <Row label="Email admins" htmlFor="enterprise-alert-admins" description="At 80% and 100% of every limit and budget.">
        <Switch
          id="enterprise-alert-admins"
          checked={alerts.admins}
          onCheckedChange={(admins) => update.mutate({ alerts: { admins } })}
          disabled={!canEdit || update.isPending}
        />
      </Row>
      <Recipients ws={ws} recipients={alerts.recipients} canEdit={canEdit} />
    </PartSection>
  )
}

export function PrivacyPart({ ws, settings, canEdit }: PartProps) {
  const update = useUpdateEnterprise(ws)
  const { privacy } = settings
  const set = (patch: Partial<typeof privacy>) => update.mutate({ privacy: patch })
  return (
    <PartSection ws={ws} part="privacy" settings={settings} canEdit={canEdit}>
      {!canEdit && <Block className="text-sm text-muted-foreground">Only owners change these settings.</Block>}
      <Row
        label="Delete documents as soon as a job finishes"
        htmlFor="enterprise-privacy-delete"
        description="Instead of keeping them for the time set under Printing. Finished jobs can’t be retried."
      >
        <Switch
          id="enterprise-privacy-delete"
          checked={privacy.deleteWhenFinished}
          onCheckedChange={(deleteWhenFinished) => set({ deleteWhenFinished })}
          disabled={!canEdit || update.isPending}
        />
      </Row>
      <Row
        label="Show document names only to the person who printed them"
        htmlFor="enterprise-privacy-names"
        description="Everyone else sees “Document”, in the app, emails, the API, and AI assistants."
      >
        <Switch
          id="enterprise-privacy-names"
          checked={privacy.ownerOnlyNames}
          onCheckedChange={(ownerOnlyNames) => set({ ownerOnlyNames })}
          disabled={!canEdit || update.isPending}
        />
      </Row>
      <Row label="Owners and admins can see document names" htmlFor="enterprise-privacy-admins">
        <Switch
          id="enterprise-privacy-admins"
          checked={privacy.adminsSeeNames}
          onCheckedChange={(adminsSeeNames) => set({ adminsSeeNames })}
          disabled={!canEdit || !privacy.ownerOnlyNames || update.isPending}
        />
      </Row>
    </PartSection>
  )
}
