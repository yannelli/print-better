import type { UsageMeter } from '@shared/usage'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { meterLine } from '../usage/words'

const TONES = {
  ok: '',
  near: '[&_[data-slot=progress-indicator]]:bg-warn',
  over: '[&_[data-slot=progress-indicator]]:bg-destructive',
}

/** One count of a limit: its name, how full it is, what is left and when it starts over. */
export function Meter({ name, meter, currency, timeZone, className }: { name: string; meter: UsageMeter; currency: string; timeZone: string; className?: string }) {
  const share = meter.amount > 0 ? Math.min(100, Math.round((meter.used / meter.amount) * 100)) : 100
  const tone = meter.left <= 0 ? 'over' : share >= 80 ? 'near' : 'ok'
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <span className="truncate text-[0.9375rem] font-medium">{name}</span>
      <Progress value={share} aria-label={`${name}: ${share}% used`} className={cn('[&_[data-slot=progress-track]]:h-2', TONES[tone])} />
      <span className={cn('text-sm', tone === 'over' ? 'text-destructive' : 'text-muted-foreground')}>{meterLine(meter, currency, timeZone)}</span>
    </div>
  )
}
