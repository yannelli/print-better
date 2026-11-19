import type { CSSProperties } from 'react'
import { Toaster as Sonner } from 'sonner'
import { useIsDark } from '@/hooks/prefs'

export function Toaster() {
  const dark = useIsDark()
  return (
    <Sonner
      theme={dark ? 'dark' : 'light'}
      position="bottom-center"
      closeButton
      duration={5000}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--success-bg': 'var(--ok-container)',
          '--success-text': 'var(--on-ok-container)',
          '--success-border': 'transparent',
          '--error-bg': 'var(--bad-container)',
          '--error-text': 'var(--on-bad-container)',
          '--error-border': 'transparent',
          '--border-radius': '1.25rem',
        } as CSSProperties
      }
      toastOptions={{ className: 'text-[0.9375rem]! font-sans! px-5! py-4!' }}
      richColors
    />
  )
}
