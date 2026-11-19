import { afterEach, describe, expect, it, vi } from 'vitest'

/** Minimal browser surface the prefs module touches; enough to run it outside a DOM. */
function fakeBrowser(stored: string | null, osDark = false) {
  const store = new Map<string, string>(stored === null ? [] : [['pb-prefs', stored]])
  const classes = new Set<string>()
  const meta = { content: '', setAttribute: (_: string, v: string) => (meta.content = v) }
  const root = {
    dataset: {} as Record<string, string>,
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
  }
  const media = { matches: osDark, listeners: [] as (() => void)[], addEventListener: (_: string, fn: () => void) => media.listeners.push(fn) }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  vi.stubGlobal('document', { documentElement: root, querySelectorAll: () => [meta] })
  vi.stubGlobal('window', { matchMedia: () => media, addEventListener: () => undefined })
  return { store, classes, root, meta, media }
}

async function load(stored: string | null, osDark = false) {
  const env = fakeBrowser(stored, osDark)
  vi.resetModules()
  return { env, ...(await import('./prefs')) }
}

afterEach(() => vi.unstubAllGlobals())

describe('prefs', () => {
  it('starts from defaults and follows the OS theme', async () => {
    const { prefsStore, env } = await load(null, true)
    expect(prefsStore.get()).toEqual({ theme: 'system', accent: 'ink', textSize: 'default', density: 'comfortable' })
    expect(env.classes.has('dark')).toBe(true)
    expect(env.root.dataset).toEqual({ accent: 'ink', text: 'default', density: 'comfortable' })
    expect(env.meta.content).toBe('#000000')
  })

  it('merges saved values over defaults and survives broken storage', async () => {
    expect((await load('{"accent":"rose","textSize":"larger"}')).prefsStore.get()).toMatchObject({
      theme: 'system',
      accent: 'rose',
      textSize: 'larger',
    })
    expect((await load('{not json')).prefsStore.get().accent).toBe('ink')
  })

  it('saves changes, applies them and notifies subscribers', async () => {
    const { prefsStore, env } = await load(null)
    const seen = vi.fn()
    prefsStore.subscribe(seen)
    prefsStore.set({ theme: 'dark', density: 'compact' })
    expect(JSON.parse(env.store.get('pb-prefs')!)).toMatchObject({ theme: 'dark', density: 'compact' })
    expect(env.classes.has('dark')).toBe(true)
    expect(env.root.dataset.density).toBe('compact')
    expect(seen).toHaveBeenCalledOnce()
    prefsStore.reset()
    expect(env.store.has('pb-prefs')).toBe(false)
    expect(env.classes.has('dark')).toBe(false)
  })

  it('re-renders when the OS switches theme while set to automatic', async () => {
    const { prefsStore, isDark, env } = await load(null, false)
    const before = prefsStore.get()
    env.media.matches = true
    env.media.listeners.forEach((fn) => fn())
    expect(prefsStore.get()).not.toBe(before)
    expect(isDark()).toBe(true)
    expect(isDark({ ...before, theme: 'light' })).toBe(false)
  })
})
