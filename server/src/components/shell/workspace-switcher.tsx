import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { useLocation } from 'wouter'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSession } from '@/hooks/auth'
import { rememberWorkspace } from '@/hooks/workspace'
import { initials } from '@/lib/format'
import { ROLE_NAMES } from '@/lib/words'
import { useAppActions, wsHref } from './app-actions'

function Monogram({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-foreground text-sm font-semibold tracking-tight text-background"
    >
      {initials(name)}
    </span>
  )
}

export function WorkspaceSwitcher({ ws }: { ws: string }) {
  const workspaces = useSession().data?.workspaces ?? []
  const current = workspaces.find((w) => w.id === ws)
  const [, navigate] = useLocation()
  const { openNewWorkspace } = useAppActions()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="press flex h-14 w-full items-center gap-3 rounded-2xl px-2 text-left hover:bg-muted aria-expanded:bg-muted"
        aria-label={`Workspace: ${current?.name ?? 'none'}. Switch workspace`}
      >
        <Monogram name={current?.name ?? '?'} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[0.9375rem] font-semibold">{current?.name ?? 'Workspace'}</span>
          {current && <span className="text-sm text-muted-foreground">{ROLE_NAMES[current.role]}</span>}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onClick={() => {
                rememberWorkspace(w.id)
                navigate(wsHref(w.id))
              }}
            >
              <Monogram name={w.name} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{w.name}</span>
                <span className="text-sm text-muted-foreground">{ROLE_NAMES[w.role]}</span>
              </span>
              {w.id === ws && <Check className="size-4" aria-label="Current" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={openNewWorkspace}>
          <Plus />
          New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
