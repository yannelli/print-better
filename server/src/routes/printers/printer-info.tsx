import { Link } from 'wouter'
import type { Printer, RouteKind } from '@shared/types'
import { Mono, Row, Section } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { StatusDot } from '@/components/status'
import { date } from '@/lib/format'

const ROUTES: Record<RouteKind, string> = {
  ipps: 'Network, encrypted',
  ipp: 'Network',
  socket: 'Network, direct port',
  lpd: 'Network, older LPD',
  usb: 'USB cable',
  os: 'Printer set up on the computer',
}

const FORMATS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/pwg-raster': 'PWG Raster',
  'image/urf': 'Apple Raster',
  'application/vnd.hp-pcl': 'PCL',
  'application/postscript': 'PostScript',
  'text/plain': 'Plain text',
}

export function PrinterInfo({ ws, printer }: { ws: string; printer: Printer }) {
  const caps = printer.capabilities
  const known = [...new Set(caps.formats.flatMap((f) => FORMATS[f] ?? []))]
  const others = caps.formats.filter((f) => !FORMATS[f]).length
  const formats = others ? [...known, `${others} other ${others === 1 ? 'type' : 'types'}`] : known
  return (
    <Section title="Details" id="details" flush>
      {printer.makeModel && <Row label="Model" description={printer.makeModel} />}
      <Row
        label="Connected through"
        description={
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={printer.clientOnline ? 'ok' : 'neutral'} />
            <Link href={wsHref(ws, `/devices/${printer.clientId}`)} className="underline underline-offset-4 hover:text-foreground">
              {printer.clientName}
            </Link>
            <span>{printer.clientOnline ? '(online)' : '(offline)'}</span>
          </span>
        }
      />
      <Row label="Location" description={printer.location || 'Not set'} />
      <Row
        label="How it's reached"
        description={
          printer.routes.length ? (
            <span className="mt-1 flex flex-col gap-1.5">
              {printer.routes.map((r, i) => (
                <span key={`${r.kind}-${i}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                  <span>{ROUTES[r.kind]}</span>
                  <Mono className="break-all text-foreground">{r.uri}</Mono>
                </span>
              ))}
            </span>
          ) : (
            'No connection found yet'
          )
        }
      />
      <Row
        label="Can print"
        description={[caps.color ? 'Color' : 'Black and white', caps.duplex ? 'both sides' : 'one side'].join(', ')}
      />
      {formats.length > 0 && <Row label="File types it understands" description={formats.join(', ')} />}
      {caps.resolutions.length > 0 && (
        <Row label="Sharpness" description={<Mono>{caps.resolutions.map((r) => `${r} dpi`).join(', ')}</Mono>} />
      )}
      <Row label="Printer ID" description={<Mono className="break-all">{printer.uuid ?? printer.key}</Mono>} />
      <Row label="First seen" description={date(printer.createdAt)} />
    </Section>
  )
}
