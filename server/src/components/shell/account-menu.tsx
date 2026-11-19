import { Bot, LogOut, Monitor, Moon, Palette, ShieldCheck, Sun, UserRound } from 'lucide-react'
import { useLocation } from 'wouter'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSignOut, useUser } from '@/hooks/auth'
import { usePrefs } from '@/hooks/prefs'
import { initials } from '@/lib/format'
import { prefsStore, type Theme } from '@/lib/prefs'
import { useAppActions } from './app-actions'

export function AccountMenu() {
  const user = useUser()
  const signOut = useSignOut()
  const [, navigate] = useLocation()
  const { theme } = usePrefs()
  const { openCustomize } = useAppActions()
  if (!user) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="press flex h-14 w-full items-center gap-3 rounded-2xl px-2 text-left hover:bg-muted aria-expanded:bg-muted"
        aria-label={`Account: ${user.name}`}
      >
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-container text-sm font-semibold text-on-brand-container"
        >
          {initials(user.name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[0.9375rem] font-medium">{user.name}</span>
          <span className="truncate text-sm text-muted-foreground">{user.email ?? `@${user.username}`}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => navigate('~/account')}>
            <UserRound />
            Your account
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('~/connect')}>
            <Bot />
            Connect AI
          </DropdownMenuItem>
          {user.isAdmin && (
            <DropdownMenuItem onClick={() => navigate('~/admin')}>
              <ShieldCheck />
              Server admin
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(value) => prefsStore.set({ theme: value as Theme })}>
            <DropdownMenuRadioItem value="light">
              <Sun />
              Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon />
              Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <Monitor />
              Match this device
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuItem onClick={openCustomize}>
            <Palette />
            Customize look
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
