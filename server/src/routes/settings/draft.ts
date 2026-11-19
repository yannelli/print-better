import { useState } from 'react'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Fields of `draft` that differ from `base`, so saves only send what changed. */
export function changed<T extends object>(draft: T, base: T): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (!same(draft[key], base[key])) out[key] = draft[key]
  }
  return out
}

/** Local edits over server data: a clean draft follows server changes, a dirty one keeps unsaved edits. */
export function useDraft<T extends object>(source: T) {
  const [state, setState] = useState({ base: source, draft: source })
  let { base, draft } = state
  if (!same(source, base)) {
    const next = { base: source, draft: same(draft, base) ? source : draft }
    setState(next)
    base = next.base
    draft = next.draft
  }
  return {
    draft,
    dirty: !same(draft, base),
    changes: () => changed(draft, base),
    set: (patch: Partial<T>) => setState((s) => ({ ...s, draft: { ...s.draft, ...patch } })),
    reset: () => setState((s) => ({ ...s, draft: s.base })),
  }
}
