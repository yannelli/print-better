import { Cable, Wifi } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useMemo, useState } from 'react'
import { OptionCards } from '@/components/option-cards'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { HOSTNAME_RE, type PiConfig, SSH_KEY_RE, USERNAME_RE, wifiPasswordProblem } from '../cloud-init'

const COUNTRIES = ['US', 'CA', 'MX', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'PT', 'JP', 'KR', 'IN', 'BR', 'ZA', 'SG']

function defaultCountry() {
  try {
    return new Intl.Locale(navigator.language).maximize().region ?? 'US'
  } catch {
    return 'US'
  }
}

interface Form {
  hostname: string
  connection: 'wifi' | 'cable'
  ssid: string
  wifiPassword: string
  country: string
  hidden: boolean
  username: string
  password: string
  sshKey: string
  timezone: string
}

type Errors = Partial<Record<keyof Form, string>>

function validate(f: Form): Errors {
  const e: Errors = {}
  if (!HOSTNAME_RE.test(f.hostname)) e.hostname = 'Use lowercase letters, numbers and dashes, up to 63 characters.'
  if (f.connection === 'wifi') {
    if (!f.ssid.trim()) e.ssid = 'Enter the name of your Wi-Fi network.'
    const wifi = wifiPasswordProblem(f.wifiPassword)
    if (wifi) e.wifiPassword = wifi
  }
  if (!USERNAME_RE.test(f.username) || f.username === 'root') e.username = 'Use lowercase letters and numbers, starting with a letter.'
  if (!f.password && !f.sshKey.trim()) e.password = 'Choose a password, or add an SSH key below.'
  if (f.sshKey.trim() && !SSH_KEY_RE.test(f.sshKey.trim())) e.sshKey = 'This doesn’t look like an SSH public key (it starts with ssh-ed25519 or ssh-rsa).'
  if (!f.timezone.trim()) e.timezone = 'Choose a time zone.'
  return e
}

function TextField({ id, label, help, error, children }: { id: string; label: string; help?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {help && !error && <FieldDescription>{help}</FieldDescription>}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  )
}

export function PiForm({ initial, onSubmit }: { initial?: PiConfig; onSubmit: (cfg: PiConfig) => void }) {
  const uid = useId()
  const id = (name: string) => `${uid}-${name}`
  const [form, setForm] = useState<Form>(() => ({
    hostname: initial?.hostname ?? 'printbridge',
    connection: initial && !initial.wifi ? 'cable' : 'wifi',
    ssid: initial?.wifi?.ssid ?? '',
    wifiPassword: initial?.wifi?.password ?? '',
    country: initial?.wifi?.country ?? defaultCountry(),
    hidden: initial?.wifi?.hidden ?? false,
    username: initial?.username ?? 'printbetter',
    password: initial?.password ?? '',
    sshKey: initial?.sshKey ?? '',
    timezone: initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }))
  const [showPasswords, setShowPasswords] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const errors = submitted ? validate(form) : {}
  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))
  const input = (key: 'hostname' | 'ssid' | 'wifiPassword' | 'username' | 'password' | 'timezone') => ({
    id: id(key),
    value: form[key],
    onChange: (e: { target: { value: string } }) => set(key)(e.target.value),
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `${id(key)}-error` : undefined,
  })

  const countries = useMemo(() => {
    const names = new Intl.DisplayNames(undefined, { type: 'region' })
    const codes = COUNTRIES.includes(form.country) ? COUNTRIES : [form.country, ...COUNTRIES]
    return codes.map((code) => ({ value: code, label: names.of(code) ?? code })).sort((a, b) => a.label.localeCompare(b.label))
  }, [form.country])
  const timezones = useMemo(() => Intl.supportedValuesOf('timeZone'), [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (Object.keys(validate(form)).length) return
    onSubmit({
      hostname: form.hostname,
      wifi: form.connection === 'wifi' ? { ssid: form.ssid, password: form.wifiPassword, country: form.country, hidden: form.hidden } : null,
      username: form.username,
      password: form.password,
      sshKey: form.sshKey.trim(),
      timezone: form.timezone.trim(),
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-8">
      <TextField id={id('hostname')} label="Name for the Pi" help="How it shows up on your network and in Print Better." error={errors.hostname}>
        <Input {...input('hostname')} autoComplete="off" spellCheck={false} className="font-mono" />
      </TextField>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-[0.9375rem] font-medium">How will it connect to the internet?</legend>
        <OptionCards<Form['connection']>
          label="Connection"
          columns={2}
          layout="inline"
          value={form.connection}
          onChange={set('connection')}
          options={[
            { value: 'wifi', label: 'Wi-Fi', media: <Wifi /> },
            { value: 'cable', label: 'Network cable', media: <Cable /> },
          ]}
        />
        {form.connection === 'wifi' && (
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField id={id('ssid')} label="Wi-Fi network name" error={errors.ssid}>
              <Input {...input('ssid')} autoComplete="off" spellCheck={false} />
            </TextField>
            <TextField id={id('wifiPassword')} label="Wi-Fi password" help="Leave empty if the network has no password." error={errors.wifiPassword}>
              <Input {...input('wifiPassword')} type={showPasswords ? 'text' : 'password'} autoComplete="off" />
            </TextField>
            <Field>
              <FieldLabel htmlFor={id('country')}>Country</FieldLabel>
              <Select items={countries} value={form.country} onValueChange={(v) => v && set('country')(v)}>
                <SelectTrigger id={id('country')} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {countries.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Wi-Fi rules differ by country.</FieldDescription>
            </Field>
            <label className="flex items-center gap-3 self-center text-[0.9375rem]">
              <Checkbox checked={form.hidden} onCheckedChange={(c) => set('hidden')(c === true)} />
              This network is hidden
            </label>
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-[0.9375rem] font-medium">Sign-in for the Pi itself</legend>
        <TextField id={id('username')} label="Username" error={errors.username}>
          <Input {...input('username')} autoComplete="off" spellCheck={false} className="font-mono" />
        </TextField>
        <TextField id={id('password')} label="Password" help="For signing in to the Pi later, if you ever need to." error={errors.password}>
          <Input {...input('password')} type={showPasswords ? 'text' : 'password'} autoComplete="new-password" />
        </TextField>
        <div className="sm:col-span-2">
          <TextField id={id('sshKey')} label="SSH public key (optional)" help="For people who sign in with SSH keys instead of a password." error={errors.sshKey}>
            <Textarea
              id={id('sshKey')}
              value={form.sshKey}
              onChange={(e) => set('sshKey')(e.target.value)}
              aria-invalid={errors.sshKey ? true : undefined}
              aria-describedby={errors.sshKey ? `${id('sshKey')}-error` : undefined}
              spellCheck={false}
              placeholder="ssh-ed25519 AAAA…"
              className="min-h-20 font-mono text-sm"
            />
          </TextField>
        </div>
        <TextField id={id('timezone')} label="Time zone" error={errors.timezone}>
          <Input {...input('timezone')} list={id('timezones')} autoComplete="off" spellCheck={false} />
          <datalist id={id('timezones')}>
            {timezones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </TextField>
        <label className="flex items-center gap-3 self-end pb-3 text-[0.9375rem]">
          <Checkbox checked={showPasswords} onCheckedChange={(c) => setShowPasswords(c === true)} />
          Show passwords
        </label>
      </fieldset>

      <div>
        <Button type="submit" size="lg">
          Create setup files
        </Button>
      </div>
    </form>
  )
}
