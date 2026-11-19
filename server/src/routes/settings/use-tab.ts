import { useLocation, useParams } from 'wouter'

/** Keeps the selected tab in the URL (`/<base>/<tab>`) so it survives reloads and can be linked to. */
export function useTab<T extends string>(base: string, tabs: readonly T[]): [T, (tab: T) => void] {
  const { tab } = useParams<{ tab?: string }>()
  const [, navigate] = useLocation()
  const current = tabs.includes(tab as T) ? (tab as T) : tabs[0]
  const select = (next: T) => navigate(next === tabs[0] ? `~/${base}` : `~/${base}/${next}`, { replace: true })
  return [current, select]
}
