import { CircuitBoard, Laptop, LaptopMinimal, Monitor, Server } from 'lucide-react'
import type { Client } from '@shared/types'

export function DeviceIcon({ client, className }: { client: Pick<Client, 'os' | 'arch'>; className?: string }) {
  const Icon =
    client.os === 'macos'
      ? Laptop
      : client.os === 'windows'
        ? Monitor
        : client.os === 'linux'
          ? client.arch && /^(arm|aarch64)/.test(client.arch)
            ? CircuitBoard
            : Server
          : LaptopMinimal
  return <Icon className={className} aria-hidden />
}
