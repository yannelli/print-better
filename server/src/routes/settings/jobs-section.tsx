import type { Workspace } from '@shared/types'
import { Row, Section } from '@/components/page'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useUpdateWorkspace } from '@/hooks/workspace'
import { useDraft } from './draft'
import { type Choice, ChoiceSelect, SaveBar } from './fields'

function hoursLabel(hours: number) {
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`
  return hours === 1 ? '1 hour' : `${hours} hours`
}

/** Preset hour choices, plus the current value when it was set elsewhere (API, MCP). */
function hourChoices(presets: number[], current: number): Choice<string>[] {
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b)
  return values.map((h) => ({ value: String(h), label: hoursLabel(h) }))
}

const KEEP = [1, 24, 72, 168, 720]
const TIMEOUT = [1, 6, 24, 72, 168]

export function JobsSection({ workspace, canManage }: { workspace: Workspace; canManage: boolean }) {
  const update = useUpdateWorkspace(workspace.id)
  const { settings } = workspace
  const { draft, dirty, set, reset } = useDraft({
    keepDocumentsHours: String(settings.keepDocumentsHours),
    jobTimeoutHours: String(settings.jobTimeoutHours),
    maxUploadMb: String(settings.maxUploadMb),
  })
  const upload = Number(draft.maxUploadMb)
  const uploadInvalid = !Number.isInteger(upload) || upload < 1 || upload > 500

  const save = () => {
    const next = {
      keepDocumentsHours: Number(draft.keepDocumentsHours),
      jobTimeoutHours: Number(draft.jobTimeoutHours),
      maxUploadMb: upload,
    }
    const patch = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => settings[key as keyof typeof next] !== value),
    )
    update.mutate({ settings: patch })
  }

  return (
    <Section id="jobs" title="Print jobs" flush>
      <Row
        label="Keep documents for"
        htmlFor="ws-keep"
        description="After this, printed files are deleted from the server. The job stays in the list."
      >
        <ChoiceSelect
          id="ws-keep"
          value={draft.keepDocumentsHours}
          onChange={(keepDocumentsHours) => set({ keepDocumentsHours })}
          options={hourChoices(KEEP, settings.keepDocumentsHours)}
          disabled={!canManage}
        />
      </Row>
      <Row
        label="Keep trying for"
        htmlFor="ws-timeout"
        description="If a printer is off or out of paper, Print Better retries this long before giving up."
      >
        <ChoiceSelect
          id="ws-timeout"
          value={draft.jobTimeoutHours}
          onChange={(jobTimeoutHours) => set({ jobTimeoutHours })}
          options={hourChoices(TIMEOUT, settings.jobTimeoutHours)}
          disabled={!canManage}
        />
      </Row>
      <Row label="Largest file people can print" htmlFor="ws-upload" description="In megabytes, from 1 to 500.">
        <div className="flex w-full flex-col gap-1.5 sm:w-64">
          <div className="flex items-center gap-2">
            <Input
              id="ws-upload"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={draft.maxUploadMb}
              onChange={(e) => set({ maxUploadMb: e.target.value })}
              disabled={!canManage}
              aria-invalid={uploadInvalid || undefined}
              className="tabular w-28"
            />
            <span className="text-muted-foreground">MB</span>
          </div>
          {uploadInvalid && <FieldError>Enter a whole number from 1 to 500.</FieldError>}
        </div>
      </Row>
      {canManage && (
        <SaveBar dirty={dirty} pending={update.isPending} onSave={save} onReset={reset} disabled={uploadInvalid} />
      )}
    </Section>
  )
}
