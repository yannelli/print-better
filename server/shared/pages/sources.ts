import type { ByteSource } from '../usage'

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }
}

/** A browser File or any Blob, read with slice(). */
export function blobSource(blob: Blob): ByteSource {
  return { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) }
}
