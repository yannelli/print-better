const latin1Decoder = new TextDecoder('latin1')

/** One character per byte. */
export const latin1 = (bytes: Uint8Array): string => latin1Decoder.decode(bytes)

export function matches(bytes: Uint8Array, at: number, pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) if (bytes[at + i] !== pattern.charCodeAt(i)) return false
  return true
}

/** The last `pattern` starting at or before `from`, or -1. */
export function lastIndexOf(bytes: Uint8Array, pattern: string, from = bytes.length - pattern.length): number {
  const first = pattern.charCodeAt(0)
  for (let at = from < 0 ? -1 : bytes.lastIndexOf(first, from); at >= 0; at = at > 0 ? bytes.lastIndexOf(first, at - 1) : -1) {
    if (matches(bytes, at, pattern)) return at
  }
  return -1
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
