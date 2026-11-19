import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function useCopy() {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      toast.error('Copy did not work here. Select the text and copy it by hand.')
    }
  }
  return { copied, copy }
}

export function CopyButton({
  value,
  label = 'Copy',
  variant = 'outline',
  size = 'sm',
  className,
}: {
  value: string
  label?: string
  variant?: 'outline' | 'default' | 'tonal' | 'ghost'
  size?: 'sm' | 'default' | 'icon-sm'
  className?: string
}) {
  const { copied, copy } = useCopy()
  const Icon = copied ? Check : Copy
  return (
    <Button type="button" variant={variant} size={size} className={className} onClick={() => copy(value)} aria-label={size === 'icon-sm' ? label : undefined}>
      <Icon data-icon="inline-start" />
      {size !== 'icon-sm' && (copied ? 'Copied' : label)}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </Button>
  )
}

/** A value shown in full (never truncated) with a copy button: tokens, URLs, commands. */
export function CopyField({ value, label, multiline, className }: { value: string; label?: string; multiline?: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && <span className="text-sm font-medium">{label}</span>}
      <div className="flex items-start gap-2 rounded-2xl border bg-surface p-2 pl-4">
        <code
          className={cn(
            'min-w-0 flex-1 py-1.5 font-mono text-sm leading-relaxed select-all',
            multiline ? 'break-all whitespace-pre-wrap' : 'overflow-x-auto whitespace-nowrap',
          )}
        >
          {value}
        </code>
        <CopyButton value={value} label={`Copy ${label?.toLowerCase() ?? ''}`.trim()} size="icon-sm" variant="ghost" />
      </div>
    </div>
  )
}
