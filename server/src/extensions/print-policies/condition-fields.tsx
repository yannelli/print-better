import { X } from 'lucide-react'
import { useState } from 'react'
import type { FileKind, PolicySubject, RuleConditions } from '@shared/policies'
import { FILE_KIND_WORDS, SOURCE_WORDS } from '@shared/policy-text'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/ui/toggle'
import { SubjectIcon, SubjectPicker } from '@/extensions/printer-access/subject-picker'
import type { SubjectOption } from '@/extensions/printer-access/subjects'
import { subjectParam } from '@/lib/api/access'
import { ChoiceSelect } from '@/routes/settings/fields'
import { CheckList } from './checklist'
import type { PolicySources } from './names'
import { NumberInput } from './number-input'
import type { ConditionKey } from './rule-form'

type Sources = NonNullable<RuleConditions['sources']>
const SOURCES = (Object.keys(SOURCE_WORDS) as Sources).map((value) => ({ value, label: SOURCE_WORDS[value].replace(/^the /, '').replace(/^a /, '') }))
const KINDS = (Object.keys(FILE_KIND_WORDS) as FileKind[]).map((value) => ({ value, label: FILE_KIND_WORDS[value] }))
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => ({ value: (i + 1) % 7, label }))

function Who({ value, onChange, sources, names }: { value: PolicySubject[]; onChange: (v: PolicySubject[]) => void; sources: PolicySources; names: (s: PolicySubject) => string }) {
  const [picked, setPicked] = useState<SubjectOption | null>(null)
  const kinds = sources.groups.length > 0 ? (['user', 'group', 'client'] as const) : (['user', 'client'] as const)
  const chosen = new Set(value.map((s) => subjectParam(s)))
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {value.map((s) => (
            <li key={subjectParam(s)} className="flex items-center gap-1.5 rounded-full border py-1 pr-1 pl-1.5 text-sm">
              <SubjectIcon type={s.type} className="size-6" />
              {names(s)}
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${names(s)}`} onClick={() => onChange(value.filter((x) => subjectParam(x) !== subjectParam(s)))}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <SubjectPicker
        sources={sources}
        kinds={kinds}
        exclude={chosen}
        value={picked}
        placeholder="Add a person, group or device"
        onChange={(option) => {
          const s = option?.subject
          if (s && s.type !== 'everyone') onChange([...value, s])
          setPicked(null)
        }}
      />
    </div>
  )
}

/** The editor for one condition of a rule. */
export function ConditionField({ field, conditions, onChange, sources, names }: {
  field: ConditionKey
  conditions: RuleConditions
  onChange: (c: RuleConditions) => void
  sources: PolicySources
  names: (s: PolicySubject) => string
}) {
  const set = <K extends ConditionKey>(key: K, value: RuleConditions[K]) => onChange({ ...conditions, [key]: value })
  const c = conditions
  switch (field) {
    case 'who':
      return <Who value={c.who ?? []} onChange={(v) => set('who', v)} sources={sources} names={names} />
    case 'sources':
      return <CheckList label="Sources" options={SOURCES} value={c.sources ?? []} onChange={(v) => set('sources', v)} />
    case 'printers':
      return <CheckList label="Printers" options={sources.printers.map((p) => ({ value: p.id, label: p.name }))} value={c.printers ?? []} onChange={(v) => set('printers', v)} />
    case 'fileKinds':
      return <CheckList label="File types" options={KINDS} value={c.fileKinds ?? []} onChange={(v) => set('fileKinds', v)} />
    case 'pages':
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          At least
          <NumberInput label="At least" value={c.pages?.min} onChange={(min) => set('pages', { ...c.pages, min })} />
          and at most
          <NumberInput label="At most" value={c.pages?.max} onChange={(max) => set('pages', { ...c.pages, max })} />
          pages, counting copies
        </div>
      )
    case 'minCopies':
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <NumberInput label="Copies" value={c.minCopies} onChange={(n) => set('minCopies', n)} />
          copies or more
        </div>
      )
    case 'minSizeMb':
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <NumberInput label="Megabytes" value={c.minSizeMb} onChange={(n) => set('minSizeMb', n)} decimals />
          MB or more
        </div>
      )
    case 'color':
      return (
        <ChoiceSelect
          ariaLabel="Color"
          value={c.color === false ? 'mono' : 'color'}
          onChange={(v) => set('color', v === 'color')}
          options={[
            { value: 'color', label: 'Prints in color', description: 'It asks for color, or for automatic on a color printer.' },
            { value: 'mono', label: 'Prints in black and white' },
          ]}
        />
      )
    case 'sides':
      return (
        <ChoiceSelect
          ariaLabel="Sides"
          value={c.sides ?? 'one-sided'}
          onChange={(v) => set('sides', v)}
          options={[
            { value: 'one-sided', label: 'Asks for one-sided' },
            { value: 'two-sided', label: 'Asks for two-sided' },
          ]}
        />
      )
    case 'time': {
      const time = c.time ?? { days: [], from: '00:00', to: '00:00' }
      return (
        <div className="flex flex-col gap-3">
          <div role="group" aria-label="Days" className="flex flex-wrap gap-1.5">
            {DAYS.map((d) => (
              <Toggle
                key={d.value}
                variant="outline"
                size="sm"
                pressed={time.days.includes(d.value)}
                onPressedChange={(on) => set('time', { ...time, days: on ? [...time.days, d.value] : time.days.filter((x) => x !== d.value) })}
              >
                {d.label}
              </Toggle>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            From
            <Input type="time" aria-label="From" value={time.from} onChange={(e) => set('time', { ...time, from: e.target.value })} className="w-32" />
            to
            <Input type="time" aria-label="To" value={time.to} onChange={(e) => set('time', { ...time, to: e.target.value })} className="w-32" />
          </div>
          <p className="text-sm text-muted-foreground">In the workspace time zone. An end before the start runs past midnight; the same time on both means all day.</p>
        </div>
      )
    }
  }
}
