import { ArrowUpRight, Menu, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'wouter'
import { Logo } from '@/components/logo'
import { Button, buttonVariants } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { MOD_KEY } from '@/lib/keys'
import { DocsSidebar } from './sidebar'

function MobileMenu({ slug }: { slug: string | null }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open docs menu" className="-ml-1 lg:hidden">
        <Menu className="size-6" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="flex w-[min(20rem,88vw)] flex-col gap-3 p-3 pt-14">
          <SheetTitle className="sr-only">Docs menu</SheetTitle>
          <div className="-mx-1 flex-1 overflow-y-auto px-1 pb-6">
            <DocsSidebar currentSlug={slug} onNavigate={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

export function DocsHeader({ slug, onSearch }: { slug: string | null; onSearch: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[88rem] items-center gap-2 px-3 sm:px-6">
        <MobileMenu slug={slug} />
        <Link href="/docs" className="press flex items-center gap-2 rounded-full px-1 py-1">
          <Logo className="size-7" />
          <span className="hidden font-semibold tracking-tight sm:inline">Print Better</span>
          <span className="text-muted-foreground">Docs</span>
        </Link>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search the docs"
          className="press flex size-11 items-center justify-center gap-3 rounded-full text-muted-foreground hover:text-foreground sm:h-10 sm:w-64 sm:justify-start sm:border sm:bg-background sm:px-4 sm:hover:border-input"
        >
          <Search className="size-5 sm:size-4" aria-hidden />
          <span className="hidden flex-1 text-left text-sm sm:inline">Search the docs</span>
          <Kbd className="hidden sm:inline-flex" aria-hidden>
            {MOD_KEY} K
          </Kbd>
        </button>
        <Link href="/" className={buttonVariants({ size: 'sm' })}>
          <span className="sm:hidden">Open app</span>
          <span className="hidden sm:inline">Open Print Better</span>
          <ArrowUpRight data-icon="inline-end" aria-hidden />
        </Link>
      </div>
    </header>
  )
}
