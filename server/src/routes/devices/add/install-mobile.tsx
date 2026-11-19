import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import type { Enrollment } from '@shared/types'
import { CopyField } from '@/components/copy'
import { QrCode } from '@/components/qr-code'
import { buttonVariants } from '@/components/ui/button'
import { ExpiryNote } from './install-command'
import { NumberedSteps, StepHeading } from './steps'

/** What the app's scanner and the Camera app open: this server and a single-use pairing code. */
export const pairingLink = (enrollment: Enrollment): string =>
  `printbetter://pair?server=${encodeURIComponent(enrollment.server)}&token=${encodeURIComponent(enrollment.token)}`

// iPadOS reports itself as a Mac; touch support gives it away.
const onIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (/mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

export function InstallMobile({ enrollment }: { enrollment: Enrollment }) {
  const [here] = useState(onIOS)
  const link = pairingLink(enrollment)
  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        title="Connect your iPhone or iPad"
        description="The Print Better app prints to this workspace’s printers from anywhere, from the app or from the Share button in any app."
      />
      <NumberedSteps>
        {[
          <p key="install">Install the Print Better app on your iPhone or iPad.</p>,
          <div key="scan" className="flex flex-col items-start gap-4">
            <p>
              Open it, tap <strong>Scan QR Code</strong>, and point the camera at this code. The Camera app works too.
            </p>
            <QrCode value={link} label="QR code that connects the Print Better app to this workspace" className="size-56 rounded-2xl border" />
            {here && (
              <a href={link} className={buttonVariants({ size: 'lg' })}>
                <ExternalLink data-icon="inline-start" />
                Open in Print Better
              </a>
            )}
          </div>,
          <div key="sign-in" className="flex flex-col gap-3">
            <p>
              No camera handy? In the app, enter this address and tap <strong>Sign In to Connect</strong>.
            </p>
            <CopyField value={enrollment.server} label="Print Better address" />
          </div>,
        ]}
      </NumberedSteps>
      <ExpiryNote enrollment={enrollment} />
    </div>
  )
}
