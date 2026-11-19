import { DOC_TYPES } from '../../../shared/printing'
import { bool, choice, integer, nullableText, object, text } from '../tool'

export const DOC_TYPE = choice('Document type', DOC_TYPES)

export const JOB_OPTIONS = object(
  {
    copies: integer('Number of copies', 1, 999),
    media: text('Paper size keyword from the printer capabilities, e.g. iso_a4_210x297mm or na_letter_8.5x11in'),
    sides: choice('One- or two-sided', ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']),
    colorMode: choice('Color or black and white', ['auto', 'color', 'monochrome']),
    orientation: choice('Page orientation', ['auto', 'portrait', 'landscape']),
    pageRanges: text('Pages to print, e.g. "1-3,5"'),
    fit: choice('How pages are scaled to the paper', ['fit', 'fill', 'none']),
    quality: choice('Print quality', ['draft', 'normal', 'high']),
    source: text('Paper tray from the printer capabilities (sources), e.g. tray-1'),
    mediaType: text('Paper type from the printer capabilities (mediaTypes), e.g. labels'),
  },
  [],
  'Print options; anything omitted uses the printer defaults',
)

export const WORKSPACE_SETTINGS = object(
  {
    autoAdd: choice(
      'Which discovered printers join the workspace automatically: smart (USB and system printers, plus network printers when a device sees 3 or fewer), all, or none',
      ['smart', 'all', 'none'],
    ),
    keepDocumentsHours: integer('Hours to keep documents after printing', 1, 2160),
    jobTimeoutHours: integer('Hours before an unfinished job is marked failed', 1, 336),
    maxUploadMb: integer('Largest document accepted, in MB', 1, 100),
    lanSharing: bool('Default LAN sharing for newly paired devices'),
    emailToPrint: object(
      {
        enabled: bool('Accept print jobs by email'),
        allowMembers: bool('Members with a verified email address may send jobs'),
        allowlist: { type: 'array', items: { type: 'string' }, description: 'Other allowed senders: full addresses or "@domain"' },
      },
      [],
      'Email-to-print policy',
    ),
    defaultPrinterId: nullableText('Printer used when print omits printerId; null clears it'),
  },
  [],
  'Settings to change; nested values are merged',
)

export const DEVICE_SETTINGS = object(
  {
    tray: bool('Show the menu bar or tray icon'),
    lanSharing: bool("Share this device's printers on the local network"),
    autoAdd: choice('Auto-add rule for this device; inherit uses the workspace setting', ['inherit', 'smart', 'all', 'none']),
    discovery: object(
      { mdns: bool('Network printers via Bonjour/mDNS'), snmp: bool('Network scan via SNMP'), usb: bool('USB printers'), os: bool('Printers installed in the operating system') },
      [],
      'Where the device looks for printers',
    ),
    paused: bool('Hold jobs on this device until resumed'),
    logLevel: choice('Log detail', ['info', 'debug']),
    remotePrinters: bool("Show the workspace's printers on other devices as local printers on this computer (macOS and Linux)"),
    autoUpdate: bool('Install new Print Better releases automatically (macOS and Linux)'),
  },
  [],
  'Settings to change; the device applies them when online',
)

export const PRINTER_SETTINGS = object(
  {
    lanShare: bool('Share this printer on the local network'),
    email: object(
      { enabled: bool('Accept email-to-print for this printer'), alias: nullableText('Email alias (the part before @); null or "" clears it') },
      [],
      'Email-to-print for this printer',
    ),
  },
  [],
  'Settings to change',
)

const secret = (what: string) => nullableText(`${what} (write-only: a string sets it, null clears it)`)

export const INSTANCE_SETTINGS = {
  appName: text('Name shown in the app'),
  signup: choice('Who may create accounts: invite (invite links only) or open (anyone)', ['invite', 'open']),
  sso: object(
    {
      google: object({ enabled: bool('Offer Sign in with Google'), clientId: nullableText('Google OAuth client id'), clientSecret: secret('Google OAuth client secret') }, [], 'Google'),
      oidc: object(
        {
          enabled: bool('Offer the OpenID Connect provider'),
          name: nullableText('Button label, e.g. the company name'),
          issuer: nullableText('Issuer URL (must serve OpenID discovery)'),
          clientId: nullableText('Client id'),
          clientSecret: secret('Client secret'),
        },
        [],
        'Generic OpenID Connect provider',
      ),
    },
    [],
    'Single sign-on',
  ),
  email: object(
    {
      provider: choice('Outbound email provider', ['none', 'resend', 'cloudflare']),
      from: nullableText('From address for outbound email'),
      apiKey: secret('Resend API key'),
      webhookSecret: secret('Resend inbound webhook signing secret (whsec_…)'),
      inbound: choice('Email-to-print channel', ['none', 'cloudflare', 'resend']),
      inboundDomain: nullableText('Domain that receives print emails'),
    },
    [],
    'Email delivery and email-to-print',
  ),
}
