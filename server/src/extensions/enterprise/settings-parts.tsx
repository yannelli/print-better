import { ArrowRight } from 'lucide-react'
import { Link } from 'wouter'
import { Row } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { type Choice, ChoiceSelect } from '@/routes/settings/fields'
import { useUpdateEnterprise } from './hooks'
import { PartSection, type PartProps } from './part-section'
import { hoursLabel } from './words'

/** Preset hour choices, plus the current value when it was set through the API or MCP. */
function hourChoices(presets: number[], current: number): Choice<string>[] {
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b)
  return values.map((h) => ({ value: String(h), label: hoursLabel(h) }))
}

function OpenLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className={buttonVariants({ variant: 'outline' })}>
      {children}
      <ArrowRight data-icon="inline-end" />
    </Link>
  )
}

export function ApprovalsPart({ ws, settings, canEdit }: PartProps) {
  const update = useUpdateEnterprise(ws)
  return (
    <PartSection
      ws={ws}
      part="approvals"
      settings={settings}
      canEdit={canEdit}
      offWarning="Jobs waiting for approval are canceled with “Approvals were turned off”. Printer switches, budgets, and rules keep their settings."
    >
      <Row
        label="Cancel unanswered requests after"
        htmlFor="enterprise-approval-expiry"
        description="Each job that waits this long is canceled with “Not approved in time”."
      >
        <ChoiceSelect
          id="enterprise-approval-expiry"
          value={String(settings.approvals.expiryHours)}
          onChange={(value) => update.mutate({ approvals: { expiryHours: Number(value) } })}
          options={hourChoices([1, 4, 8, 24, 48, 72, 168], settings.approvals.expiryHours)}
          disabled={!canEdit || update.isPending}
        />
      </Row>
      <Row
        label="Where it applies"
        description="Turn on Every job needs approval on a printer’s Approval and release tab, or set a budget, limit, or rule to require approval."
      >
        <OpenLink href={wsHref(ws, '/printers')}>Printers</OpenLink>
      </Row>
    </PartSection>
  )
}

export function ReleasePart({ ws, settings, canEdit }: PartProps) {
  const update = useUpdateEnterprise(ws)
  return (
    <PartSection
      ws={ws}
      part="release"
      settings={settings}
      canEdit={canEdit}
      offWarning="Jobs waiting to be released are canceled with “Secure release was turned off”. Printer switches and rules keep their settings."
    >
      <Row
        label="Cancel unreleased jobs after"
        htmlFor="enterprise-release-expiry"
        description="Each job that waits this long is canceled with “Not released in time”, and its document is deleted."
      >
        <ChoiceSelect
          id="enterprise-release-expiry"
          value={String(settings.release.expiryHours)}
          onChange={(value) => update.mutate({ release: { expiryHours: Number(value) } })}
          options={hourChoices([1, 2, 4, 8, 24, 72], settings.release.expiryHours)}
          disabled={!canEdit || update.isPending}
        />
      </Row>
      <Row
        label="Where it applies"
        description="Turn on Hold jobs until released on a printer’s Approval and release tab, or add a rule that holds jobs for release. People release their jobs from Print jobs > Ready to release."
      >
        <OpenLink href={wsHref(ws, '/printers')}>Printers</OpenLink>
      </Row>
    </PartSection>
  )
}

export function CostCentersPart({ ws, settings, canEdit }: PartProps) {
  const update = useUpdateEnterprise(ws)
  return (
    <PartSection ws={ws} part="costCenters" settings={settings} canEdit={canEdit}>
      <Row
        label="Every job needs a cost center"
        htmlFor="enterprise-cost-required"
        description="Jobs without one, picked or by default, are refused. Test pages always print."
      >
        <Switch
          id="enterprise-cost-required"
          checked={settings.costCenters.required}
          onCheckedChange={(required) => update.mutate({ costCenters: { required } })}
          disabled={!canEdit || update.isPending}
        />
      </Row>
      {settings.costCenters.enabled && (
        <Row label="Cost centers, defaults, and budgets" description="On the Usage page.">
          <OpenLink href={wsHref(ws, '/usage/cost-centers')}>Cost centers</OpenLink>
        </Row>
      )}
    </PartSection>
  )
}

export function ReportsPart({ ws, settings, canEdit }: PartProps) {
  return (
    <PartSection ws={ws} part="reports" settings={settings} canEdit={canEdit}>
      {settings.reports.enabled && (
        <Row label="Reports, scheduled emails, and the audit export" description="On the Usage page.">
          <OpenLink href={wsHref(ws, '/usage/reports')}>Reports</OpenLink>
        </Row>
      )}
    </PartSection>
  )
}
