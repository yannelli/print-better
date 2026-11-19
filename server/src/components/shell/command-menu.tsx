import { Search } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { type CommandItem, filterCommands, useCommandItems } from './command-items'

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD_KEY = isMac ? '⌘' : 'Ctrl'

function grouped(items: CommandItem[]) {
  const groups = new Map<string, CommandItem[]>()
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  return [...groups.entries()]
}

export function CommandMenu({ ws, open, onOpenChange }: { ws: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const all = useCommandItems(ws)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const results = useMemo(() => filterCommands(all, query), [all, query])
  const groups = useMemo(() => grouped(results), [results])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (item: CommandItem | undefined) => {
    if (!item) return
    onOpenChange(false)
    item.run()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = results.length - 1
    const moves: Record<string, () => number> = {
      ArrowDown: () => (active >= last ? 0 : active + 1),
      ArrowUp: () => (active <= 0 ? last : active - 1),
      Home: () => 0,
      End: () => last,
    }
    if (moves[e.key]) {
      e.preventDefault()
      setActive(moves[e.key]())
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[active])
    }
  }

  let index = -1
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <DialogDescription className="sr-only">Type to find a page, printer, device or action. Use the arrow keys and Enter.</DialogDescription>
        <div className="flex items-center gap-3 border-b px-5">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            data-focus-ring="none"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search or jump to…"
            className="h-16 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {results.length === 0 && <p className="px-4 py-10 text-center text-muted-foreground">Nothing matches “{query}”.</p>}
          {groups.map(([group, items]) => (
            <div key={group} role="group" aria-label={group} className="py-1">
              <div className="px-3 pt-2 pb-1.5 text-sm text-muted-foreground">{group}</div>
              {items.map((item) => {
                index += 1
                const i = index
                const Icon = item.icon
                return (
                  <div
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={() => run(item)}
                    className={cn(
                      'flex h-12 cursor-pointer items-center gap-3 rounded-xl px-3 text-[0.9375rem]',
                      i === active && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <Icon className="size-5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint && <span className="truncate text-sm text-muted-foreground">{item.hint}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
