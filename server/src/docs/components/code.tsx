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
    <figure className="docs-code group/code my-6 overflow-hidden rounded-2xl border bg-surface">
      {title && <figcaption className="border-b px-4 py-2 font-mono text-xs text-muted-foreground">{title}</figcaption>}
      {/* Phones always show the button, so it gets its own column; wider screens show it over the code on hover. */}
      <div className="relative flex items-start">
        <pre
          ref={ref}
          className={cn('min-w-0 flex-1 overflow-x-auto py-4 pr-4 pl-4 font-mono text-[0.8125rem] leading-6 sm:pr-14', className)}
          style={style}
          tabIndex={0}
        >
          {children}
        </pre>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => copy(ref.current?.innerText.replace(/\n$/, '') ?? '')}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="m-2 bg-surface transition-opacity sm:absolute sm:top-0 sm:right-0 sm:opacity-0 sm:group-hover/code:opacity-100 sm:focus-visible:opacity-100"
        >
          <Icon className={cn(copied && 'text-ok')} />
        </Button>
      </div>
    </figure>
  )
}

/** Inline code and the code inside highlighted blocks. */
export function Code({ children, ...rest }: ComponentProps<'code'>) {
  return <code {...rest}>{replaceOrigin(children)}</code>
}
