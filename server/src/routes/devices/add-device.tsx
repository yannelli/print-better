import { ArrowLeft, Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Enrollment } from '@shared/types'
import { PageHeader } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { EmptyState, ErrorState, Loading } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useClients, useCreateEnrollment } from '@/hooks/devices'
import { useCanManage, useWs } from '@/hooks/workspace'
import { ChooseKind } from './add/choose-kind'
import { InstallLinux, InstallWindows } from './add/install-command'
import { InstallMac } from './add/install-mac'
import { PickPrinters } from './add/pick-printers'
import { PiFiles } from './add/pi-files'
import { PiForm } from './add/pi-form'
import { StepIndicator } from './add/steps'
import { TestPage } from './add/test-page'
import { WaitForDevice } from './add/wait-for-device'
import type { PiConfig } from './cloud-init'
import { CHOICE_LABELS, type DeviceChoice } from './detect-os'

const STEPS = ['Choose', 'Install', 'Connect', 'Printers', 'Test page']
const PI_TOKEN_HOURS = 168

type PiState = { config: PiConfig; ready: boolean } | null

function Install({ choice, enrollment, pi, setPi }: { choice: DeviceChoice; enrollment: Enrollment; pi: PiState; setPi: (pi: PiState) => void }) {
  if (choice === 'mac') return <InstallMac enrollment={enrollment} />
  if (choice === 'windows') return <InstallWindows enrollment={enrollment} />
  if (choice === 'linux') return <InstallLinux enrollment={enrollment} />
  if (pi?.ready) return <PiFiles config={pi.config} enrollment={enrollment} onEdit={() => setPi({ ...pi, ready: false })} />
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Set up your Raspberry Pi</h2>
        <p className="max-w-prose text-muted-foreground">
          Fill this in once. We’ll make setup files for the Pi’s memory card, right here in your browser.
        </p>
      </div>
      <PiForm initial={pi?.config} onSubmit={(config) => setPi({ config, ready: true })} />
    </div>
  )
}

function Wizard({ ws }: { ws: string }) {
  const clients = useClients(ws)
  const [known, setKnown] = useState<Set<string> | null>(null)
  const [step, setStep] = useState(0)
  const [choice, setChoice] = useState<DeviceChoice | null>(null)
  const [pi, setPi] = useState<PiState>(null)
  const [enrollment, setEnrollment] = useState<{ value: Enrollment; long: boolean } | null>(null)
  const create = useCreateEnrollment(ws)

  useEffect(() => {
    if (!known && clients.data) setKnown(new Set(clients.data.map((c) => c.id)))
  }, [known, clients.data])
  const newClient = (known && clients.data?.find((c) => !known.has(c.id))) || null

  useEffect(() => {
    if (newClient && step === 1) setStep(2)
  }, [newClient, step])

  const mint = (next: DeviceChoice) => {
    const long = next === 'pi'
    if (enrollment && (enrollment.long || !long)) return
    create.mutate(
      { label: CHOICE_LABELS[next], ...(long ? { ttlHours: PI_TOKEN_HOURS } : {}) },
      { onSuccess: (value) => setEnrollment({ value, long }) },
    )
  }

  const choose = (next: DeviceChoice) => {
    setChoice(next)
    setStep(1)
    mint(next)
  }

  const content = () => {
    if (step === 0) return <ChooseKind initial={choice} onChoose={choose} />
    if (step === 1 && choice) {
      if (create.isError) return <ErrorState error={create.error} onRetry={() => mint(choice)} />
      if (!enrollment || create.isPending) return <Loading label="Preparing your setup code" />
      const waitingOnPiForm = choice === 'pi' && !pi?.ready
      return (
        <div className="flex flex-col gap-8">
          <Install choice={choice} enrollment={enrollment.value} pi={pi} setPi={setPi} />
          <div className="flex flex-wrap gap-3 border-t pt-6">
            <Button variant="ghost" onClick={() => setStep(0)}>
              <ArrowLeft data-icon="inline-start" />
              Back
            </Button>
            {!waitingOnPiForm && (
              <Button variant="outline" onClick={() => setStep(2)}>
                {choice === 'pi' ? 'I’ve started the Pi' : 'I’ve done this'}
              </Button>
            )}
          </div>
        </div>
      )
    }
    if (step === 2) {
      return (
        <div className="flex flex-col gap-8">
          <WaitForDevice ws={ws} client={newClient} isPi={choice === 'pi'} onContinue={() => setStep(3)} />
          {!newClient && (
            <div className="border-t pt-6">
              <Button variant="ghost" onClick={() => setStep(1)}>
                <ArrowLeft data-icon="inline-start" />
                Back to the install steps
              </Button>
            </div>
          )}
        </div>
      )
    }
    if (step === 3 && newClient) {
      return <PickPrinters ws={ws} client={newClient} onDone={() => setStep(4)} onSkip={() => setStep(4)} />
    }
    if (step === 4 && newClient) return <TestPage ws={ws} client={newClient} />
    return <ChooseKind initial={choice} onChoose={choose} />
  }

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <StepIndicator steps={STEPS} current={step} />
      {content()}
    </div>
  )
}

export default function AddDevice() {
  const ws = useWs()
  const canManage = useCanManage()
  return (
    <>
      <PageHeader title="Add a device" back={{ href: wsHref(ws, '/devices'), label: 'Devices' }} />
      {canManage ? (
        <Wizard ws={ws} />
      ) : (
        <EmptyState
          icon={Lock}
          title="Only admins can add devices"
          description="Ask an owner or admin of this workspace to add the device, or to make you an admin."
        />
      )}
    </>
  )
}
