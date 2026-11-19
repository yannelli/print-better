import { CircuitBoard, Laptop, Monitor, Server } from 'lucide-react'
import { useState } from 'react'
import { type Option, OptionCards } from '@/components/option-cards'
import { Button } from '@/components/ui/button'
import { type DeviceChoice, detectChoice } from '../detect-os'
import { StepHeading } from './steps'

const OPTIONS: Option<DeviceChoice>[] = [
  { value: 'mac', label: 'Mac', description: 'A MacBook, iMac or Mac mini', media: <Laptop /> },
  { value: 'windows', label: 'Windows PC', description: 'Windows 10 or 11', media: <Monitor /> },
  { value: 'linux', label: 'Linux computer', description: 'Ubuntu, Debian, Fedora and others', media: <Server /> },
  { value: 'pi', label: 'Raspberry Pi', description: 'Set up a new Pi as a printer bridge', media: <CircuitBoard /> },
]

export function ChooseKind({ initial, onChoose }: { initial: DeviceChoice | null; onChoose: (choice: DeviceChoice) => void }) {
  const [detected] = useState(detectChoice)
  const [choice, setChoice] = useState<DeviceChoice | ''>(initial ?? detected ?? '')
  const options = OPTIONS.map((o) =>
    o.value === detected ? { ...o, description: <>{o.description}. Looks like you’re using one now.</> } : o,
  )
  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        title="What will connect your printers?"
        description="Pick the computer that is near your printers, or connected to them with a cable. It needs to stay on for printing to work."
      />
      <OptionCards<DeviceChoice | ''>
        label="Kind of device"
        columns={2}
        layout="inline"
        value={choice}
        onChange={setChoice}
        options={options}
      />
      <div>
        <Button size="lg" disabled={!choice} onClick={() => choice && onChoose(choice)}>
          Continue
        </Button>
      </div>
    </div>
  )
}
