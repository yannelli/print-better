import { CircleAlert, ShieldCheck, Unlock } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { wsHref } from '@/components/shell/app-actions'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useExtensionActive } from '@/hooks/extensions'
import { usePrinterRights } from '@/hooks/access'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { SlotProps } from '../registry'
import { usePrices } from '../usage/hooks'
import { meterLine } from '../usage/words'
import { useApprovals, useEnterprise, useMyUsage, useReady, useReleaseAll } from './hooks'
import { isApprover } from './words'

function Card({ icon: Icon, title, children, tone }: { icon: typeof ShieldCheck; title: string; children?: ReactNode; tone?: 'warn' }) {
  return (
    <section className={cn('flex flex-col gap-3 rounded-3xl border bg-card p-5', tone === 'warn' && 'border-transparent bg-warn-container text-on-warn-container')}>
      <h2 className="flex items-center gap-2.5 text-[0.9375rem] font-medium">
        <Icon aria-hidden className="size-4.5 shrink-0" />
        {title}
      </h2>
      {children}
    </section>
  )
}

/** At or over 80% of a limit that counts the caller's jobs. */
function LimitAlert({ ws }: { ws: string }) {
  const limits = useMyUsage(ws, true).data?.limits ?? []
  const prices = usePrices(ws).data
  const near = limits.filter((l) => l.amount > 0 && l.used >= l.amount * 0.8).sort((a, b) => b.used / b.amount - a.used / a.amount)[0]
  if (!near || !prices) return null
  return (
    <Card icon={CircleAlert} tone="warn" title={near.used >= near.amount ? `You reached ${near.name}` : `You used ${Math.floor((near.used / near.amount) * 100)}% of ${near.name}`}>
      <p className="text-sm">{meterLine(near, prices.currency, prices.timeZone)}.</p>
    </Card>
  )
}

function WaitingForYou({ ws }: { ws: string }) {
  const count = useApprovals(ws).data?.length ?? 0
  if (count === 0) return null
  return (
    <Card icon={ShieldCheck} title={`${plural(count, 'job')} ${count === 1 ? 'waits' : 'wait'} for your approval`}>
      <Link href={wsHref(ws, '/jobs/approvals')} className={buttonVariants({ variant: 'outline', className: 'w-fit' })}>
        Review
      </Link>
    </Card>
  )
}

function ReadyForYou({ ws }: { ws: string }) {
  const count = useReady(ws).data?.length ?? 0
  const releaseAll = useReleaseAll(ws)
  if (count === 0) return null
  return (
    <Card icon={Unlock} title={count === 1 ? '1 of your jobs is ready to release' : `${count} of your jobs are ready to release`}>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => releaseAll.mutate(undefined)} disabled={releaseAll.isPending}>
          {releaseAll.isPending ? <Spinner data-icon="inline-start" /> : <Unlock data-icon="inline-start" />}
          {count === 1 ? 'Release' : 'Release all'}
        </Button>
        <Link href={wsHref(ws, '/jobs/release')} className={buttonVariants({ variant: 'outline' })}>
          See jobs
        </Link>
      </div>
    </Card>
  )
}

/** Home: a limit running out, approvals waiting for you, and your jobs ready to release. */
export default function EnterpriseHome({ ws }: SlotProps['homeSection']) {
  const settings = useEnterprise(ws).data?.settings
  const rights = usePrinterRights(ws)
  const limits = useExtensionActive(ws, 'print-policies')
  if (!settings) return null
  return (
    <>
      {limits && settings.alerts.enabled && settings.alerts.personal && <LimitAlert ws={ws} />}
      {settings.approvals.enabled && isApprover(rights) && <WaitingForYou ws={ws} />}
      {settings.release.enabled && <ReadyForYou ws={ws} />}
    </>
  )
}
