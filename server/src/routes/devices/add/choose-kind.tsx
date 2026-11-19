import { CircuitBoard, Laptop, Monitor, Server, Smartphone } from 'lucide-react'
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
  { value: 'iphone', label: 'iPhone', description: 'Print from your iPhone to these printers', media: <Smartphone /> },
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
        title="What are you adding?"
        description="A computer near your printers, or connected to them with a cable, connects them to Print Better and needs to stay on. An iPhone prints to them from anywhere."
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
