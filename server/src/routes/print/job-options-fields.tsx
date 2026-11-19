import { ChevronDown } from 'lucide-react'
import { useId, useState } from 'react'
import type { JobOptions, Printer } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ChoiceSelect } from './choice-select'
import { CopiesStepper } from './copies-stepper'
import {
  COLOR_CHOICES,
  type ColorChoice,
  FIT_CHOICES,
  ORIENTATION_CHOICES,
  PAGE_RANGES,
  paperChoices,
  QUALITY_CHOICES,
  SIDE_CHOICES,
} from './job-options'

function Labeled({ id, label, children, className }: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
    </Field>
  )
}

/** Print settings for one printer. `print` mode adds page ranges and tucks rarer settings away. */
export function JobOptionsFields({
  printer,
  value,
  onChange,
  mode,
  disabled,
}: {
  printer: Printer
  value: JobOptions
  onChange: (next: JobOptions) => void
  mode: 'print' | 'defaults'
  disabled?: boolean
}) {
  const id = useId()
  const [more, setMore] = useState(mode === 'defaults')
  const caps = printer.capabilities
  const set = <K extends keyof JobOptions>(key: K, v: JobOptions[K]) => onChange({ ...value, [key]: v })
  const pagesInvalid = !!value.pageRanges && !PAGE_RANGES.test(value.pageRanges)

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Labeled id={`${id}-copies`} label="Copies">
          <CopiesStepper id={`${id}-copies`} value={value.copies ?? 1} max={caps.copiesMax} onChange={(n) => set('copies', n)} disabled={disabled} />
        </Labeled>
        {caps.color && (
          <Labeled id={`${id}-color`} label="Color">
            <ChoiceSelect<ColorChoice>
              id={`${id}-color`}
              value={value.colorMode === 'monochrome' ? 'monochrome' : 'color'}
              onChange={(v) => set('colorMode', v)}
              options={COLOR_CHOICES}
              disabled={disabled}
            />
          </Labeled>
        )}
        {caps.duplex && (
          <Labeled id={`${id}-sides`} label="Sides">
            <ChoiceSelect id={`${id}-sides`} value={value.sides ?? 'one-sided'} onChange={(v) => set('sides', v)} options={SIDE_CHOICES} disabled={disabled} />
          </Labeled>
        )}
        {caps.media.length > 0 && value.media && (
          <Labeled id={`${id}-paper`} label="Paper">
            <ChoiceSelect id={`${id}-paper`} value={value.media} onChange={(v) => set('media', v)} options={paperChoices(printer)} disabled={disabled} />
          </Labeled>
        )}
        {mode === 'print' && (
          <Field data-invalid={pagesInvalid || undefined} className="sm:col-span-2">
            <FieldLabel htmlFor={`${id}-pages`}>Pages</FieldLabel>
            <Input
              id={`${id}-pages`}
              value={value.pageRanges ?? ''}
              onChange={(e) => set('pageRanges', e.target.value)}
              placeholder="All pages, or e.g. 1-3, 5"
              inputMode="numeric"
              aria-invalid={pagesInvalid || undefined}
              aria-describedby={`${id}-pages-help`}
              disabled={disabled}
            />
            {pagesInvalid ? (
              <FieldError id={`${id}-pages-help`}>Use page numbers and dashes, like 1-3, 5.</FieldError>
            ) : (
              <FieldDescription id={`${id}-pages-help`}>Leave empty to print everything.</FieldDescription>
            )}
          </Field>
        )}
      </div>
      {mode === 'print' && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 self-start"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
        >
          <ChevronDown data-icon="inline-start" className={cn('transition-transform duration-300 ease-spring', more && 'rotate-180')} />
          {more ? 'Fewer options' : 'More options'}
        </Button>
      )}
      {more && (
        <div className="grid gap-5 sm:grid-cols-2">
          <Labeled id={`${id}-orientation`} label="Page direction">
            <ChoiceSelect id={`${id}-orientation`} value={value.orientation ?? 'auto'} onChange={(v) => set('orientation', v)} options={ORIENTATION_CHOICES} disabled={disabled} />
          </Labeled>
          <Labeled id={`${id}-fit`} label="Size on the page">
            <ChoiceSelect id={`${id}-fit`} value={value.fit ?? 'fit'} onChange={(v) => set('fit', v)} options={FIT_CHOICES} disabled={disabled} />
          </Labeled>
          <Labeled id={`${id}-quality`} label="Quality">
            <ChoiceSelect id={`${id}-quality`} value={value.quality ?? 'normal'} onChange={(v) => set('quality', v)} options={QUALITY_CHOICES} disabled={disabled} />
          </Labeled>
        </div>
      )}
    </div>
  )
}

export function pageRangesValid(options: JobOptions) {
  return !options.pageRanges || PAGE_RANGES.test(options.pageRanges)
}
