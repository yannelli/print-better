import { useQuery } from '@tanstack/react-query'
import { CircleCheck } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useSearchParams } from 'wouter'
import { isMobileOs } from '@shared/types'
import { OptionCards } from '@/components/option-cards'
import { Mono } from '@/components/page'
import { Loading } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { preferredWorkspace } from '@/hooks/workspace'
import { devicesApi } from '@/lib/api/devices'
import type { DeviceCodeInfo } from '@/lib/api/types'
import { dateTime } from '@/lib/format'
import { OS_NAMES } from '@/lib/words'
import { DeviceIcon } from '@/routes/devices/device-icon'
import { AuthLayout, FormError } from './auth-layout'
import { DeviceCodeForm } from './device-code-form'
import { TextField, useSubmit } from './fields'

type Outcome = { kind: 'approved'; ws: string } | { kind: 'denied' }

function DeviceFacts({ info }: { info: DeviceCodeInfo }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border bg-surface p-4">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand-container text-on-brand-container">
        <DeviceIcon client={info} className="size-6" />
      </span>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.9375rem]">
        <dt className="text-muted-foreground">{isMobileOs(info.os) ? 'Device' : 'Computer'}</dt>
        <dd className="truncate"><Mono>{info.hostname}</Mono></dd>
        <dt className="text-muted-foreground">System</dt>
        <dd>{OS_NAMES[info.os] ?? info.os} ({info.arch})</dd>
        <dt className="text-muted-foreground">App version</dt>
        <dd><Mono>{info.version}</Mono></dd>
      </dl>
    </div>
  )
}

function Approve({ code, info, onDone }: { code: string; info: DeviceCodeInfo; onDone: (o: Outcome) => void }) {
  const manageable = info.workspaces
  const [ws, setWs] = useState(() => preferredWorkspace(manageable)?.id ?? '')
  const [name, setName] = useState(info.hostname)
  const approve = useSubmit()
  const deny = useSubmit()

  if (!manageable.length) {
    return (
      <p className="text-base text-muted-foreground">
        Only workspace admins can connect devices, and you are not an admin in any workspace. Ask an admin to open this page, or to make
        you an admin.
      </p>
    )
  }

  const onApprove = async (e: FormEvent) => {
    e.preventDefault()
    if (await approve.run(() => devicesApi.approveDevice(code, ws, name.trim() || info.hostname))) onDone({ kind: 'approved', ws })
  }
  const onDeny = async () => {
    if (await deny.run(() => devicesApi.denyDevice(code))) onDone({ kind: 'denied' })
  }

  return (
    <form onSubmit={onApprove} className="flex flex-col gap-6">
      {manageable.length > 1 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-[0.9375rem] font-medium">Which workspace should it join?</legend>
          <OptionCards
            label="Workspace"
            layout="inline"
            columns={2}
            value={ws}
            onChange={setWs}
            options={manageable.map((w) => ({ value: w.id, label: w.name }))}
          />
        </fieldset>
      )}
      <TextField
        id="device-name"
        label="Name this device"
        description="Pick something you'll recognize, like Kitchen Mac or Office PC."
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
      />
      <FormError message={approve.error ?? deny.error} />
      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" className="w-full" disabled={approve.pending || deny.pending || !ws}>
          {approve.pending && <Spinner data-icon="inline-start" />}
          Connect this device
        </Button>
        <Button type="button" variant="outline" size="lg" className="w-full" onClick={onDeny} disabled={approve.pending || deny.pending}>
          {deny.pending && <Spinner data-icon="inline-start" />}
          Don't connect
        </Button>
      </div>
    </form>
  )
}

export default function DeviceApprove() {
  const [params, setParams] = useSearchParams()
  const code = params.get('code')?.toUpperCase() ?? null
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const info = useQuery({
    queryKey: ['device-code', code],
    queryFn: () => devicesApi.deviceCode(code!),
    enabled: !!code && !outcome,
    retry: false,
  })
  const enterCode = (next: string | null) => setParams(next ? { code: next } : {})

  if (outcome?.kind === 'approved') {
    return (
      <AuthLayout title="Connected" description="Your device will appear in a few seconds. You can close the window on the device.">
        <div role="status" className="flex items-center gap-3 rounded-2xl bg-ok-container p-4 text-on-ok-container">
          <CircleCheck className="size-6 shrink-0" />
          <span>Print Better on that device is now signed in.</span>
        </div>
        <Link href={`~/w/${outcome.ws}/devices`} className={buttonVariants({ size: 'lg' })}>
          See your devices
        </Link>
      </AuthLayout>
    )
  }
  if (outcome?.kind === 'denied') {
    return (
      <AuthLayout title="Not connected" description="The device was turned away and can't use your account. You can close this page.">
        <Link href="~/" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
          Go to Home
        </Link>
      </AuthLayout>
    )
  }
  if (!code) {
    return (
      <AuthLayout title="Connect a device" description="Type the code that Print Better shows on the computer you're setting up.">
        <DeviceCodeForm onSubmit={enterCode} />
      </AuthLayout>
    )
  }
  if (info.isPending) {
    return (
      <AuthLayout title="Connect a device">
        <Loading label="Looking up the code" />
      </AuthLayout>
    )
  }
  if (info.isError || !info.data) {
    return (
      <AuthLayout title="That code didn't work" description="It may have expired (codes last 10 minutes) or have a typo. Check the code on your device and try again.">
        <DeviceCodeForm onSubmit={enterCode} initial={code} />
      </AuthLayout>
    )
  }
  return (
    <AuthLayout
      title="Connect this device?"
      description={`Only continue if you just started setting up Print Better on this ${isMobileOs(info.data.os) ? OS_NAMES[info.data.os] : 'computer'}. The code works until ${dateTime(info.data.expiresAt)}.`}
    >
      <DeviceFacts info={info.data} />
      <Approve code={code} info={info.data} onDone={setOutcome} />
    </AuthLayout>
  )
}
