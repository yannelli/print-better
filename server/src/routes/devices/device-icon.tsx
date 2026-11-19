import { CircuitBoard, Laptop, LaptopMinimal, type LucideIcon, Monitor, Server, Smartphone, Tablet } from 'lucide-react'
import type { Client, Os } from '@shared/types'

const ICONS: Record<Os, LucideIcon> = { macos: Laptop, windows: Monitor, linux: Server, ios: Smartphone, ipados: Tablet }

export function DeviceIcon({ client, className }: { client: Pick<Client, 'os' | 'arch'>; className?: string }) {
  const pi = client.os === 'linux' && !!client.arch && /^(arm|aarch64)/.test(client.arch)
  const Icon = pi ? CircuitBoard : client.os ? ICONS[client.os] : LaptopMinimal
  return <Icon className={className} aria-hidden />
}
