import { ChevronDown, Download, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'
import type { Enrollment } from '@shared/types'
import { CopyField } from '@/components/copy'
import { Mono } from '@/components/page'
import { Button } from '@/components/ui/button'
import { buildPiFiles, downloadText, type PiConfig } from '../cloud-init'
import { ExpiryNote } from './install-command'
import { NumberedSteps, StepHeading } from './steps'

const FILE_NAMES = { userData: 'user-data', networkConfig: 'network-config', metaData: 'meta-data' } as const

export function PiFiles({ config, enrollment, onEdit }: { config: PiConfig; enrollment: Enrollment; onEdit: () => void }) {
  const files = useMemo(() => buildPiFiles(config, enrollment), [config, enrollment])
  const entries = (Object.keys(FILE_NAMES) as (keyof typeof FILE_NAMES)[]).map((key) => ({ name: FILE_NAMES[key], text: files[key] }))
  const downloadAll = () => entries.forEach((f, i) => setTimeout(() => downloadText(f.name, f.text), i * 400))

  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        title="Prepare the memory card"
        description="These three small files tell your Raspberry Pi how to join your network and connect to Print Better on its first start."
      />
      <p className="flex items-start gap-3 rounded-2xl bg-ok-container p-4 text-[0.9375rem] text-on-ok-container">
        <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
        These files were made on this computer. Your Wi-Fi and Pi passwords were not sent to the server.
      </p>
      <NumberedSteps>
        {[
          <div key="download" className="flex flex-col items-start gap-3">
            <p>Download the setup files.</p>
            <Button size="lg" onClick={downloadAll}>
              <Download data-icon="inline-start" />
              Download all three files
            </Button>
            <div className="flex flex-wrap gap-2">
              {entries.map((f) => (
                <Button key={f.name} variant="outline" size="sm" onClick={() => downloadText(f.name, f.text)}>
                  <Download data-icon="inline-start" />
                  <Mono>{f.name}</Mono>
                </Button>
              ))}
            </div>
          </div>,
          <p key="imager">
            Install <strong>Raspberry Pi Imager</strong> from{' '}
            <a href="https://www.raspberrypi.com/software/" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
              raspberrypi.com/software
            </a>{' '}
            on this computer, and open it.
          </p>,
          <p key="os">
            Choose your Pi model, then <strong>Raspberry Pi OS (64-bit)</strong> for a Pi 3, 4, 5 or Zero 2 W. For a Pi
            Zero, Zero W, Pi 1 or Pi 2, choose <strong>Raspberry Pi OS (32-bit)</strong> instead.
          </p>,
          <p key="write">
            Choose your memory card. When Imager asks about settings, click <strong>Edit settings</strong> and turn on at
            least one, such as the hostname, then write the card. The Pi only reads our files when a setting is turned on.
          </p>,
          <p key="copy">
            When writing finishes, take the card out and put it back in. Open the drive called <Mono>bootfs</Mono> and copy
            the three files onto it, replacing the ones already there. Keep the names exactly <Mono>user-data</Mono>,{' '}
            <Mono>network-config</Mono> and <Mono>meta-data</Mono>, with nothing added to the end.
          </p>,
          <p key="boot">
            Eject the card, put it in the Pi, and plug in the power. The first start takes about 5 to 10 minutes. This page
            notices by itself when the Pi connects.
          </p>,
        ]}
      </NumberedSteps>
      <details className="group rounded-2xl border bg-card">
        <summary className="press flex h-12 cursor-pointer list-none items-center gap-2 rounded-2xl px-4 text-[0.9375rem] font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-4 transition-transform duration-300 ease-spring group-open:rotate-180" aria-hidden />
          See what’s inside the files
        </summary>
        <div className="flex flex-col gap-4 px-4 pb-4">
          {entries.map((f) => (
            <CopyField key={f.name} label={f.name} value={f.text} multiline />
          ))}
        </div>
      </details>
      <ExpiryNote enrollment={enrollment} />
      <div>
        <Button variant="ghost" onClick={onEdit}>
          Change the Pi settings
        </Button>
      </div>
    </div>
  )
}
