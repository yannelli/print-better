import { cn } from '@/lib/utils'
import type { StatusWords, Tone } from '@/lib/words'

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  info: 'bg-info',
  neutral: 'bg-muted-foreground/60',
}

const PILL: Record<Tone, string> = {
  ok: 'bg-ok-container text-on-ok-container',
  warn: 'bg-warn-container text-on-warn-container',
  bad: 'bg-bad-container text-on-bad-container',
  info: 'bg-info-container text-on-info-container',
  neutral: 'bg-muted text-muted-foreground',
}

export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn('relative inline-flex size-2.5 shrink-0', className)}>
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', DOT[tone])} />}
      <span className={cn('relative inline-flex size-full rounded-full', DOT[tone])} />
    </span>
  )
}

/** Tonal status chip: colour is never the only signal, the words always say it too. */
export function StatusPill({
  status,
  size = 'default',
  className,
}: {
  status: Pick<StatusWords, 'label' | 'tone'>
  size?: 'default' | 'lg'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-2 rounded-full font-medium whitespace-nowrap',
        size === 'lg' ? 'h-9 px-4 text-[0.9375rem]' : 'h-7 px-3 text-sm',
        PILL[status.tone],
        className,
      )}
    >
      <StatusDot tone={status.tone} pulse={status.tone === 'info'} className={size === 'lg' ? 'size-3' : undefined} />
      {status.label}
    </span>
  )
}

export function toneText(tone: Tone) {
  return {
    ok: 'text-on-ok-container',
    warn: 'text-on-warn-container',
    bad: 'text-on-bad-container',
    info: 'text-on-info-container',
    neutral: 'text-muted-foreground',
  }[tone]
}

export function toneContainer(tone: Tone) {
  return PILL[tone]
}
