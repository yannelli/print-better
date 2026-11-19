export type Theme = 'system' | 'light' | 'dark'
export type Accent = 'ink' | 'blue' | 'green' | 'violet' | 'rose' | 'teal'
export type TextSize = 'default' | 'large' | 'larger'
export type Density = 'comfortable' | 'compact'

export interface Prefs {
  theme: Theme
  accent: Accent
  textSize: TextSize
  density: Density
}

export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: 'ink', label: 'Ink', swatch: 'oklch(0.2 0 0)' },
  { id: 'blue', label: 'Blue', swatch: 'oklch(0.55 0.19 259)' },
  { id: 'teal', label: 'Teal', swatch: 'oklch(0.55 0.12 200)' },
  { id: 'green', label: 'Green', swatch: 'oklch(0.55 0.14 152)' },
  { id: 'violet', label: 'Violet', swatch: 'oklch(0.55 0.2 293)' },
  { id: 'rose', label: 'Rose', swatch: 'oklch(0.58 0.19 12)' },
]

const KEY = 'pb-prefs'
const DEFAULTS: Prefs = { theme: 'system', accent: 'ink', textSize: 'default', density: 'comfortable' }
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) }
  } catch {
    return DEFAULTS
  }
}

let prefs = load()
const listeners = new Set<() => void>()

export const isDark = (p: Prefs = prefs) => p.theme === 'dark' || (p.theme === 'system' && darkQuery.matches)

/** Mirrors the inline script in index.html, which applies the same attributes before first paint. */
function apply() {
  const root = document.documentElement
  const dark = isDark()
  root.classList.toggle('dark', dark)
  root.dataset.accent = prefs.accent
  root.dataset.text = prefs.textSize
  root.dataset.density = prefs.density
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#000000' : '#ffffff'))
}

export const prefsStore = {
  get: () => prefs,
  set(patch: Partial<Prefs>) {
    prefs = { ...prefs, ...patch }
    localStorage.setItem(KEY, JSON.stringify(prefs))
    apply()
    listeners.forEach((fn) => fn())
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  reset() {
    localStorage.removeItem(KEY)
    prefs = DEFAULTS
    apply()
    listeners.forEach((fn) => fn())
  },
}

darkQuery.addEventListener('change', () => {
  prefs = { ...prefs }
  apply()
  listeners.forEach((fn) => fn())
})
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  prefs = load()
  apply()
  listeners.forEach((fn) => fn())
})
apply()
