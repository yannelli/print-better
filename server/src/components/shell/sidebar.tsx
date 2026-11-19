import { Menu, Search } from 'lucide-react'
import { useState } from 'react'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { MOD_KEY } from '@/lib/keys'
import { AccountMenu } from './account-menu'
import { useAppActions } from './app-actions'
import { NavList } from './nav'
import { WorkspaceSwitcher } from './workspace-switcher'

function SearchButton() {
  const { openCommand } = useAppActions()
  return (
    <button
      type="button"
      onClick={openCommand}
      className="press flex h-11 w-full items-center gap-3 rounded-full border bg-background px-4 text-[0.9375rem] text-muted-foreground hover:border-input hover:text-foreground"
    >
      <Search className="size-4.5" />
      <span className="flex-1 text-left">Search</span>
      <Kbd aria-label={`${MOD_KEY} K`}>{MOD_KEY} K</Kbd>
    </button>
  )
}

function SidebarBody({ ws, onNavigate }: { ws: string; onNavigate?: () => void }) {
  return (
    <>
      <WorkspaceSwitcher ws={ws} />
      <SearchButton />
      <div className="-mx-1 flex-1 overflow-y-auto px-1 py-2">
        <NavList ws={ws} onNavigate={onNavigate} />
      </div>
      <AccountMenu />
    </>
  )
}

export function Sidebar({ ws }: { ws: string }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col gap-3 border-r bg-sidebar p-3 lg:flex">
      <SidebarBody ws={ws} />
    </aside>
  )
}

export function MobileBar({ ws }: { ws: string }) {
  const [open, setOpen] = useState(false)
  const { openCommand } = useAppActions()
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md lg:hidden">
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open menu">
        <Menu className="size-6" />
      </Button>
      <div className="flex flex-1 items-center gap-2">
        <Logo className="size-7" />
        <span className="font-semibold tracking-tight">Print Better</span>
      </div>
      <Button variant="ghost" size="icon" onClick={openCommand} aria-label="Search">
        <Search className="size-5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="flex w-[min(20rem,88vw)] flex-col gap-3 p-3 pt-14">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SidebarBody ws={ws} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  )
}
