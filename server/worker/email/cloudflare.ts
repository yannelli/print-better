import PostalMime, { type Header } from 'postal-mime'
import { processInbound } from './inbound'

/** Cloudflare prepends its Authentication-Results, so only the first one is trusted, and only from mx.cloudflare.net. */
export function cloudflareDmarc(headers: Header[]): 'pass' | 'fail' | null {
  const first = headers.find((h) => h.key === 'authentication-results')
  if (!first) return null
  const [authserv, ...results] = first.value.split(';')
  if (authserv.trim().toLowerCase() !== 'mx.cloudflare.net') return 'fail'
  return /\bdmarc\s*=\s*pass\b/i.test(results.join(';')) ? 'pass' : 'fail'
}

const bytes = (content: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content)

export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const email = await PostalMime.parse(message.raw)
  const from = email.from && 'address' in email.from && email.from.address ? email.from.address : message.from
  const result = await processInbound(
    env,
    {
      from,
      to: [message.to],
      subject: email.subject ?? '',
      text: email.text ?? null,
      attachments: email.attachments.map((a) => ({
        fileName: a.filename,
        contentType: a.mimeType,
        data: bytes(a.content),
        inline: a.related === true || a.disposition === 'inline',
      })),
      dmarc: cloudflareDmarc(email.headers),
    },
    'cloudflare',
    (p) => ctx.waitUntil(p),
  )
  if (result.rejected) message.setReject(result.rejected)
}
