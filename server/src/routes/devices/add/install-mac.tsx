import { ChevronDown, Download, ExternalLink } from 'lucide-react'
import type { Enrollment } from '@shared/types'
import { LOCAL_PORT } from '@shared/protocol'
import { CopyField } from '@/components/copy'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useDownloads } from '@/hooks/devices'
import { downloadUrl } from '@/lib/api/devices'
import { bytes } from '@/lib/format'
import { ExpiryNote } from './install-command'
import { NumberedSteps, StepHeading } from './steps'

function pairUrl(enrollment: Enrollment) {
  return `http://127.0.0.1:${LOCAL_PORT}/pair#server=${encodeURIComponent(enrollment.server)}&token=${enrollment.token}`
}

function TerminalOption({ enrollment, open }: { enrollment: Enrollment; open?: boolean }) {
  return (
    <details open={open} className="group rounded-2xl border bg-card">
      <summary className="press flex h-12 cursor-pointer list-none items-center gap-2 rounded-2xl px-4 text-[0.9375rem] font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 transition-transform duration-300 ease-spring group-open:rotate-180" aria-hidden />
        Use Terminal instead
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-sm text-muted-foreground">
          Open Terminal (in Applications, then Utilities), paste this command and press Return.
        </p>
        <CopyField value={enrollment.commands.unix} label="Install command" multiline />
      </div>
    </details>
  )
}

export function InstallMac({ enrollment }: { enrollment: Enrollment }) {
  const downloads = useDownloads()
  const pkg = downloads.data?.files['macos-pkg']
  const href = downloads.data && pkg ? downloadUrl(downloads.data, pkg.name) : null

  if (downloads.isPending) {
    return (
      <p className="flex items-center gap-3 text-muted-foreground" role="status">
        <Spinner /> Finding the latest version…
      </p>
    )
  }

  if (!href || !pkg) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeading
          title="Install on your Mac"
          description="The Mac installer isn’t published on this server yet, so use Terminal. It takes about a minute."
        />
        <TerminalOption enrollment={enrollment} open />
        <ExpiryNote enrollment={enrollment} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <StepHeading title="Install on your Mac" description="Do this on the Mac that will connect your printers." />
      <NumberedSteps>
        {[
          <div key="download" className="flex flex-col items-start gap-2">
            <a href={href} download className={buttonVariants({ size: 'lg' })}>
              <Download data-icon="inline-start" />
              Download Print Better for Mac
            </a>
            <span className="text-sm text-muted-foreground">
              Version {downloads.data?.version}, {bytes(pkg.size)}
            </span>
          </div>,
          <p key="install">Open the file you downloaded (it’s in your Downloads folder) and follow the installer.</p>,
          <div key="connect" className="flex flex-col items-start gap-3">
            <p>When it’s installed, connect it to this workspace:</p>
            <Button variant="tonal" onClick={() => window.open(pairUrl(enrollment), '_blank', 'noopener')}>
              <ExternalLink data-icon="inline-start" />
              Connect this Mac
            </Button>
            <span className="text-sm text-muted-foreground">
              Opens Print Better on this Mac. Use this button on the Mac you just installed it on.
            </span>
          </div>,
        ]}
      </NumberedSteps>
      <TerminalOption enrollment={enrollment} />
      <ExpiryNote enrollment={enrollment} />
    </div>
  )
}
