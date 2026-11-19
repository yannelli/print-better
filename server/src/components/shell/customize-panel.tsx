import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check, Monitor, Moon, Rows3, Rows4, Sun } from 'lucide-react'
import { OptionCards } from '@/components/option-cards'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { usePrefs } from '@/hooks/prefs'
import { type Accent, ACCENTS, type Density, prefsStore, type TextSize, type Theme } from '@/lib/prefs'

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-3 text-[0.9375rem] font-semibold">{title}</legend>
      {children}
    </fieldset>
  )
}

function AccentPicker() {
  const { accent } = usePrefs()
  return (
    <RadioGroup
      aria-label="Accent color"
      value={accent}
      onValueChange={(value) => prefsStore.set({ accent: value as Accent })}
      className="flex flex-wrap gap-3"
    >
      {ACCENTS.map((a) => (
        <Radio.Root
          key={a.id}
          value={a.id}
          aria-label={a.label}
          title={a.label}
          className="press flex size-12 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-popover data-checked:ring-2 data-checked:ring-foreground"
          style={{ background: a.swatch }}
        >
          <Radio.Indicator>
            <Check className="size-5 text-white" strokeWidth={3} />
          </Radio.Indicator>
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}

export function CustomizePanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const prefs = usePrefs()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="p-6 pb-2">
          <SheetTitle>Customize the look</SheetTitle>
          <SheetDescription>Saved on this device only. Changes apply right away.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-8 p-6">
          <Group title="Theme">
            <OptionCards<Theme>
              label="Theme"
              value={prefs.theme}
              onChange={(theme) => prefsStore.set({ theme })}
              options={[
                { value: 'light', label: 'Light', media: <Sun /> },
                { value: 'dark', label: 'Dark', media: <Moon /> },
                { value: 'system', label: 'Automatic', media: <Monitor /> },
              ]}
            />
          </Group>
          <Group title="Accent color">
            <AccentPicker />
          </Group>
          <Group title="Text size">
            <OptionCards<TextSize>
              label="Text size"
              value={prefs.textSize}
              onChange={(textSize) => prefsStore.set({ textSize })}
              options={[
                { value: 'default', label: 'Default', media: <span className="text-base font-semibold">Aa</span> },
                { value: 'large', label: 'Large', media: <span className="text-lg font-semibold">Aa</span> },
                { value: 'larger', label: 'Larger', media: <span className="text-xl font-semibold">Aa</span> },
              ]}
            />
          </Group>
          <Group title="Spacing">
            <OptionCards<Density>
              label="Spacing"
              columns={2}
              value={prefs.density}
              onChange={(density) => prefsStore.set({ density })}
              options={[
                { value: 'comfortable', label: 'Roomy', description: 'Bigger buttons, more space', media: <Rows3 /> },
                { value: 'compact', label: 'Compact', description: 'More on screen at once', media: <Rows4 /> },
              ]}
            />
          </Group>
          <Button variant="ghost" className="self-start" onClick={() => prefsStore.reset()}>
            Reset to defaults
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
