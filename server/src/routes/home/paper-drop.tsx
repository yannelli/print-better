import { ArrowUp } from 'lucide-react'
import { type DragEvent, useRef, useState } from 'react'
import { DOC_TYPES } from '@shared/types'
import { useAppActions } from '@/components/shell/app-actions'
import { cn } from '@/lib/utils'

const FOLD = '3.25rem'
const SHEET_CLIP = `polygon(0 0, calc(100% - ${FOLD}) 0, 100% ${FOLD}, 100% 100%, 0 100%)`

/** A sheet of paper you drop files onto. Two stacked clip-paths draw the hairline along the cut corner too. */
export function PaperDrop() {
  const { openPrint } = useAppActions()
  const input = useRef<HTMLInputElement>(null)
  const depth = useRef(0)
  const [over, setOver] = useState(false)

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    depth.current += 1
    setOver(true)
  }
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file) openPrint({ file })
  }

  return (
    <div className="mx-auto w-full max-w-[22rem] lg:mx-0">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragEnter={onDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-label="Print something: choose a file"
        aria-describedby="paper-drop-help"
        className={cn(
          'group/sheet block aspect-[8.5/11] w-full rounded-[1.375rem] text-left outline-offset-4',
          'transition-[translate,scale,rotate,filter] duration-700 ease-spring',
          'hover:-translate-y-1 active:scale-[0.985]',
          over && '-translate-y-3 scale-[1.03] -rotate-1 drop-shadow-2xl',
        )}
      >
        <span
          aria-hidden
          className={cn('block size-full rounded-[1.375rem] p-px transition-colors', over ? 'bg-brand' : 'bg-input group-hover/sheet:bg-muted-foreground/60')}
          style={{ clipPath: SHEET_CLIP }}
        >
          <span
            className="relative flex size-full flex-col rounded-[1.3125rem] bg-card p-7 sm:p-8"
            style={{ clipPath: `polygon(0 0, calc(100% - ${FOLD} + 0.0625rem) 0, 100% calc(${FOLD} - 0.0625rem), 100% 100%, 0 100%)` }}
          >
            <span
              className={cn(
                'absolute top-0 right-0 rounded-bl-xl border-b border-l transition-colors',
                over ? 'border-brand' : 'border-input',
              )}
              style={{ width: FOLD, height: FOLD, background: 'linear-gradient(to bottom left, transparent 50%, var(--muted) 50%)' }}
            />
            <span className="flex flex-col gap-2.5 pt-1">
              <span className="h-2 w-2/5 rounded-full bg-muted" />
              <span className="h-2 w-3/5 rounded-full bg-muted" />
              <span className="h-2 w-1/3 rounded-full bg-muted" />
            </span>
            <span className="mt-auto flex flex-col gap-4">
              <span
                className={cn(
                  'flex size-14 items-center justify-center rounded-[1.25rem] transition-[background-color,color,translate] duration-500 ease-spring',
                  over ? '-translate-y-1 bg-brand text-brand-foreground' : 'bg-brand-container text-on-brand-container',
                )}
              >
                <ArrowUp className="size-7" strokeWidth={2.25} />
              </span>
              <span className="text-[1.75rem] leading-tight font-semibold tracking-[-0.025em]">
                {over ? 'Let go to print' : 'Print something'}
              </span>
              <span id="paper-drop-help" className="text-base text-muted-foreground">
                Drop a file on this page, or click to choose one. PDF, photos and text files work.
              </span>
            </span>
          </span>
        </span>
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept={[...DOC_TYPES, '.pdf', '.jpg', '.jpeg', '.png', '.txt'].join(',')}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) openPrint({ file })
        }}
      />
    </div>
  )
}
