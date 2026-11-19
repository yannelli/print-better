import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type { InstanceExtension } from '@shared/extensions'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Switch } from '@/components/ui/switch'
import { docsUrl } from '@/extensions/docs'
import { useAdminExtensions, useSetExtensionAvailable } from '@/hooks/extensions'
import { extensionUsage } from '@/lib/words'

function ExtensionRow({ extension }: { extension: InstanceExtension }) {
  const set = useSetExtensionAvailable()
  const id = `extension-${extension.id}`
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6">
      <div className="flex min-w-0 flex-col gap-1">
        <span id={`${id}-name`} className="text-[0.9375rem] font-medium">
          {extension.name}
        </span>
        <span className="text-sm text-muted-foreground">{extension.summary}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{extensionUsage(extension.enabledWorkspaces)}</span>
          <a
            href={docsUrl(extension.docs)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
          >
            How it works
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          Available to workspaces
        </label>
        <Switch
          id={id}
          aria-describedby={`${id}-name`}
          checked={extension.available}
          disabled={set.isPending}
          onCheckedChange={(available) =>
            set.mutate(
              { id: extension.id, available },
              { onSuccess: () => toast.success(available ? `${extension.name} is available to workspaces` : `${extension.name} is off everywhere`) },
            )
          }
        />
      </div>
    </li>
  )
}

export function ExtensionsTab() {
  const extensions = useAdminExtensions()
  return (
    <Section
      id="extensions"
      title="Extensions"
      description="Optional features. Making one available lets workspace owners turn it on for their workspace. Turning it off here stops it everywhere at once, and keeps each workspace's setup for later."
      flush
    >
      <QueryState query={extensions}>
        {(list) => (
          <ul>
            {list.map((extension) => (
              <ExtensionRow key={extension.id} extension={extension} />
            ))}
          </ul>
        )}
      </QueryState>
    </Section>
  )
}
