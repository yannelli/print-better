import { FileText, Hash, Search as SearchIcon } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { buildSearchIndex, type SearchEntry } from './content-index'
import { docHref } from './nav'
import { withOrigin } from './origin'

let indexPromise: Promise<SearchEntry[]> | null = null

const wordStart = (term: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu')

function score(entry: SearchEntry, terms: string[]): number {
  const text = `${entry.page.description} ${entry.text}`
  let total = 0
  for (const term of terms) {
    const pattern = wordStart(term)
    const hit = (pattern.test(entry.page.title) ? 10 : 0) + (pattern.test(entry.heading?.text ?? '') ? 6 : 0) + (pattern.test(text) ? 1 : 0)
    if (!hit) return 0
    total += hit
  }
  return total + (entry.heading ? 0 : 0.5)
}

function snippet(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term)
  if (at < 0) return text.slice(0, 110)
  const start = Math.max(0, at - 40)
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 120)}${start + 120 < text.length ? '…' : ''}`
}

/** ⌘K or Ctrl+K anywhere, and `/` outside text fields. */
export function useSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true]')
      if ((event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
        event.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}

function useResults(query: string, open: boolean) {
  const [index, setIndex] = useState<SearchEntry[] | null>(null)
  useEffect(() => {
    if (!open) return
    indexPromise ??= buildSearchIndex()
    void indexPromise.then(setIndex)
  }, [open])
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query])
  const results = useMemo(() => {
    if (!index || !terms.length) return []
    return index
      .map((entry) => ({ entry, score: score(entry, terms) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((result) => result.entry)
  }, [index, terms])
  return { terms, results, loading: !index }
}

export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [, navigate] = useLocation()
  const listId = useId()
  const { terms, results, loading } = useResults(query, open)

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const go = (entry: SearchEntry | undefined) => {
    if (!entry) return
    onOpenChange(false)
    navigate(`${docHref(entry.page.slug)}${entry.heading ? `#${entry.heading.id}` : ''}`)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((value) => (results.length ? (value + step + results.length) % results.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      go(results[active])
    }
  }

  const message = !terms.length
    ? 'Type a word, for example “passkey” or “Raspberry Pi”.'
    : loading
      ? 'Loading the docs.'
      : !results.length
        ? `No pages match “${query}”.`
        : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search the docs</DialogTitle>
        <DialogDescription className="sr-only">Type to find a docs page or section. Use the arrow keys and Enter.</DialogDescription>
        <div className="flex items-center gap-3 border-b px-5">
          <SearchIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            data-focus-ring="none"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search the docs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search the docs"
            className="h-16 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {message && <p className="px-4 py-10 text-center text-muted-foreground">{message}</p>}
          {results.map((entry, position) => (
            <div
              key={`${entry.page.slug}#${entry.heading?.id ?? ''}`}
              id={`${listId}-${position}`}
              role="option"
              aria-selected={position === active}
              onPointerMove={() => position !== active && setActive(position)}
              onClick={() => go(entry)}
              className={cn('flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5', position === active && 'bg-accent text-accent-foreground')}
            >
              {entry.heading ? (
                <Hash className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="min-w-0">
                <span className="block truncate text-[0.9375rem] font-medium">
                  {entry.page.title}
                  {entry.heading && <span className="text-muted-foreground"> › {entry.heading.text}</span>}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-sm leading-5 text-muted-foreground">
                  {withOrigin(snippet(entry.text || entry.page.description, terms[0]!))}
                </span>
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
