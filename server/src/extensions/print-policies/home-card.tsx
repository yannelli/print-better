import { ChevronRight } from 'lucide-react'
import { Link } from 'wouter'
import { wsHref } from '@/components/shell/app-actions'
import type { SlotProps } from '../registry'
import { usePrices } from '../usage/hooks'
import { tightest } from '../usage/words'
import { useMyUsage } from './hooks'
import { Meter } from './meter'

/** Home: the limit closest to running out, only while some limit counts your jobs; the rest are on the Usage page. */
export default function HomeCard({ ws }: SlotProps['homeSection']) {
  const limits = useMyUsage(ws).data?.limits ?? []
  const prices = usePrices(ws).data
  const limit = tightest(limits)
  if (!limit || !prices) return null
  return (
    <section aria-labelledby="home-limits" className="mx-auto flex w-full max-w-[22rem] flex-col gap-3 rounded-3xl border bg-card p-5 lg:mx-0">
      <div className="flex items-center justify-between gap-3">
        <h2 id="home-limits" className="text-sm font-medium text-muted-foreground">
          {limits.length === 1 ? 'Your limit' : 'Your limits'}
        </h2>
        <Link href={wsHref(ws, '/usage')} className="-mr-2 inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          Usage
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </div>
      <Meter name={limit.name} meter={limit} currency={prices.currency} timeZone={prices.timeZone} />
    </section>
  )
}
