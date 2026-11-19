import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from './fields'

/** Device codes are 8 consonants shown as XXXX-XXXX; typing is forgiving about case and dashes. */
export function formatCode(raw: string) {
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
}

export function DeviceCodeForm({ onSubmit, initial = '' }: { onSubmit: (code: string) => void; initial?: string }) {
  const [code, setCode] = useState(formatCode(initial))
  const [attempted, setAttempted] = useState(false)
  const complete = code.length === 9
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    if (complete) onSubmit(code)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <TextField
        id="device-code"
        label="Code shown on your device"
        description="It looks like BCDF-GHJK."
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        className="h-14 text-center font-mono text-2xl tracking-[0.2em]"
        value={code}
        onChange={(e) => setCode(formatCode(e.target.value))}
        error={attempted && !complete ? 'Enter all 8 letters.' : null}
        autoFocus
      />
      <Button type="submit" size="lg" className="w-full">
        Continue
      </Button>
    </form>
  )
}
