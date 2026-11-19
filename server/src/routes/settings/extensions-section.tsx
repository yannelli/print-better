import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { ExtensionId, WorkspaceExtension } from '@shared/extensions'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { extensionDocsHref } from '@/extensions/docs'
import { useExtensions, useSetExtensionEnabled } from '@/hooks/extensions'

const CONFIRM: Record<ExtensionId, { on: string; off: string }> = {
  'printer-access': {
    on: 'Nothing changes until you restrict a printer. Every printer stays open to everyone with the User role. You can turn it off again at any time.',
    off: 'Everyone gets the usual access to every printer right away. Your groups, roles, and access choices are kept in case you turn it back on.',
  },
  'print-policies': {
    on: 'Nothing changes until you add a rule or a limit. You can turn it off again at any time.',
    off: 'Rules and limits stop applying right away. They are kept, with prices and usage history, in case you turn it back on.',
  },
  enterprise: {
    on: 'Nothing changes until you turn on one of its parts. You can turn it off again at any time.',
    off: 'Jobs waiting for approval or release are canceled, and the other controls stop applying right away. Settings, cost centers, and history are kept.',
  },
}

function status(extension: WorkspaceExtension, isOwner: boolean): string {
  if (!extension.available) {
    return extension.enabled
      ? 'Paused because a server admin made it unavailable. Your setup is kept.'
      : 'Not available on this server. Ask a server admin to make it available.'
  }
  if (isOwner) return extension.enabled ? 'On for this workspace' : 'Off'
  return extension.enabled ? 'On. Only owners can turn it off.' : 'Off. Only owners can turn it on.'
}

function ExtensionRow({ ws, extension, isOwner }: { ws: string; extension: WorkspaceExtension; isOwner: boolean }) {
  const set = useSetExtensionEnabled(ws)
  const [asking, setAsking] = useState<boolean | null>(null)
  const id = `ws-extension-${extension.id}`
  const confirm = () => {
    const enabled = !!asking
    set.mutate(
      { id: extension.id, enabled },
      {
        onSuccess: () => {
          setAsking(null)
          toast.success(enabled ? `${extension.name} is on` : `${extension.name} is off`)
        },
      },
    )
  }

  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-[0.9375rem] font-medium">
          {extension.name}
        </label>
        <span className="text-sm text-muted-foreground">{extension.summary}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{status(extension, isOwner)}</span>
          <a href={extensionDocsHref(extension)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground">
            How it works
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </span>
      </div>
      <Switch
        id={id}
        checked={extension.available && extension.enabled}
        disabled={!isOwner || !extension.available || set.isPending}
        onCheckedChange={setAsking}
      />
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && !set.isPending && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking ? `Turn on ${extension.name.toLowerCase()}?` : `Turn off ${extension.name.toLowerCase()}?`}</AlertDialogTitle>
            <AlertDialogDescription>{asking ? CONFIRM[extension.id].on : CONFIRM[extension.id].off}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={set.isPending}>Cancel</AlertDialogCancel>
            <Button onClick={confirm} disabled={set.isPending}>
              {set.isPending && <Spinner data-icon="inline-start" />}
              {asking ? 'Turn on' : 'Turn off'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

/** Optional features for this workspace. A server admin makes each one available; owners turn it on. */
export function ExtensionsSection({ ws, isOwner }: { ws: string; isOwner: boolean }) {
  const extensions = useExtensions(ws)
  return (
    <Section id="extensions" description="Optional features you can turn on for this workspace." flush>
      <QueryState query={extensions}>
        {(list) => (
          <ul>
            {list.map((extension) => (
              <ExtensionRow key={extension.id} ws={ws} extension={extension} isOwner={isOwner} />
            ))}
          </ul>
        )}
      </QueryState>
    </Section>
  )
}
