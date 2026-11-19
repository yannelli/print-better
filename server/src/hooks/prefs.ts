import { useSyncExternalStore } from 'react'
import { isDark, prefsStore } from '@/lib/prefs'

export function usePrefs() {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get)
}

export function useIsDark() {
  return isDark(usePrefs())
}
