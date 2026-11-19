import { Check, Copy } from 'lucide-react'
import { type ComponentProps, useRef } from 'react'
import { useCopy } from '@/components/copy'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { replaceOrigin } from '../origin'

export function Pre({ children, className, style, ...rest }: ComponentProps<'pre'> & { 'data-title'?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const { copied, copy } = useCopy()
  const title = rest['data-title']
  const Icon = copied ? Check : Copy
  return (
    <figure className="docs-code group/code relative my-6 overflow-hidden rounded-2xl border bg-surface">
      {title && <figcaption className="border-b px-4 py-2 font-mono text-xs text-muted-foreground">{title}</figcaption>}
      <pre ref={ref} className={cn('overflow-x-auto py-4 pr-14 pl-4 font-mono text-[0.8125rem] leading-6', className)} style={style} tabIndex={0}>
        {children}
      </pre>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => copy(ref.current?.innerText.replace(/\n$/, '') ?? '')}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className={cn(
          'absolute right-2 bg-surface transition-opacity sm:opacity-0 sm:group-hover/code:opacity-100 sm:focus-visible:opacity-100',
          title ? 'top-11' : 'top-2',
        )}
      >
        <Icon className={cn(copied && 'text-ok')} />
      </Button>
    </figure>
  )
}

/** Inline code and the code inside highlighted blocks. */
export function Code({ children, ...rest }: ComponentProps<'code'>) {
  return <code {...rest}>{replaceOrigin(children)}</code>
}
