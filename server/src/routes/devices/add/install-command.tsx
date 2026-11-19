import { Clock } from 'lucide-react'
import type { Enrollment } from '@shared/types'
import { CopyField } from '@/components/copy'
import { Mono } from '@/components/page'
import { dateTime } from '@/lib/format'
import { NumberedSteps, StepHeading } from './steps'

export function ExpiryNote({ enrollment }: { enrollment: Enrollment }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Clock className="size-4 shrink-0" aria-hidden />
      This setup code works once, until {dateTime(enrollment.expiresAt)}.
    </p>
  )
}

export function InstallWindows({ enrollment }: { enrollment: Enrollment }) {
  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        title="Install on your Windows PC"
        description="Do this on the PC that will connect your printers. It takes about a minute."
      />
      <NumberedSteps>
        {[
          <p key="open">
            Press the <strong>Windows</strong> key, type <strong>PowerShell</strong>, and open it.
          </p>,
          <div key="paste" className="flex flex-col gap-3">
            <p>Copy this command, paste it into the PowerShell window, then press Enter.</p>
            <CopyField value={enrollment.commands.windows} label="Install command" multiline />
          </div>,
          <p key="wait">Wait until it says Print Better is connected. You can close the window afterwards.</p>,
        ]}
      </NumberedSteps>
      <ExpiryNote enrollment={enrollment} />
    </div>
  )
}

export function InstallLinux({ enrollment }: { enrollment: Enrollment }) {
  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        title="Install on your Linux computer"
        description="Do this on the computer that will connect your printers. It installs Print Better as a background service that starts by itself."
      />
      <NumberedSteps>
        {[
          <p key="open">Open a terminal window.</p>,
          <div key="paste" className="flex flex-col gap-3">
            <p>Copy this command, paste it into the terminal, then press Enter.</p>
            <CopyField value={enrollment.commands.unix} label="Install command" multiline />
          </div>,
          <p key="wait" className="text-base">
            When run as <Mono>root</Mono> or on a computer without a desktop, it sets itself up as a system service
            automatically, so it keeps running with nobody signed in.
          </p>,
        ]}
      </NumberedSteps>
      <ExpiryNote enrollment={enrollment} />
    </div>
  )
}
