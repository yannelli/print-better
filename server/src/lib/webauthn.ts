// WebAuthn JSON helpers: native parse*/toJSON where available, base64url fallback for Safari < 18.4.

type CreationJSON = PublicKeyCredentialCreationOptionsJSON
type RequestJSON = PublicKeyCredentialRequestOptionsJSON

export const passkeysSupported = () => typeof window.PublicKeyCredential === 'function'

export async function conditionalMediationAvailable(): Promise<boolean> {
  if (!passkeysSupported() || typeof PublicKeyCredential.isConditionalMediationAvailable !== 'function') return false
  return PublicKeyCredential.isConditionalMediationAvailable().catch(() => false)
}

function fromB64url(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

function toB64url(buffer: ArrayBuffer | null | undefined): string | undefined {
  if (!buffer) return undefined
  const bytes = new Uint8Array(buffer)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const hasNativeJSON = () => passkeysSupported() && typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function'

function parseCreation(json: CreationJSON): PublicKeyCredentialCreationOptions {
  if (hasNativeJSON()) return PublicKeyCredential.parseCreationOptionsFromJSON(json)
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    user: { ...json.user, id: fromB64url(json.user.id) },
    excludeCredentials: json.excludeCredentials?.map((c) => ({ ...c, id: fromB64url(c.id) })) as PublicKeyCredentialDescriptor[],
  } as PublicKeyCredentialCreationOptions
}

function parseRequest(json: RequestJSON): PublicKeyCredentialRequestOptions {
  if (hasNativeJSON()) return PublicKeyCredential.parseRequestOptionsFromJSON(json)
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    allowCredentials: json.allowCredentials?.map((c) => ({ ...c, id: fromB64url(c.id) })) as PublicKeyCredentialDescriptor[],
  } as PublicKeyCredentialRequestOptions
}

function credentialJSON(cred: PublicKeyCredential): unknown {
  if (typeof cred.toJSON === 'function') return cred.toJSON()
  const r = cred.response
  const response =
    r instanceof AuthenticatorAttestationResponse
      ? {
          clientDataJSON: toB64url(r.clientDataJSON),
          attestationObject: toB64url(r.attestationObject),
          transports: r.getTransports?.() ?? [],
          publicKeyAlgorithm: r.getPublicKeyAlgorithm?.(),
          publicKey: toB64url(r.getPublicKey?.()),
          authenticatorData: toB64url(r.getAuthenticatorData?.()),
        }
      : {
          clientDataJSON: toB64url(r.clientDataJSON),
          authenticatorData: toB64url((r as AuthenticatorAssertionResponse).authenticatorData),
          signature: toB64url((r as AuthenticatorAssertionResponse).signature),
          userHandle: toB64url((r as AuthenticatorAssertionResponse).userHandle),
        }
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response,
  }
}

/** Creates a passkey and returns the credential as JSON ready for the server. */
export async function createPasskey(options: CreationJSON): Promise<unknown> {
  const cred = await navigator.credentials.create({ publicKey: parseCreation(options) })
  if (!cred) throw new Error('No passkey was created.')
  return credentialJSON(cred as PublicKeyCredential)
}

/** Asks for a passkey. With `conditional`, it waits quietly for the browser's autofill instead of a prompt. */
export async function getPasskey(options: RequestJSON, opts: { conditional?: boolean; signal?: AbortSignal } = {}) {
  const cred = await navigator.credentials.get({
    publicKey: parseRequest(options),
    mediation: opts.conditional ? 'conditional' : 'optional',
    signal: opts.signal,
  })
  if (!cred) throw new Error('No passkey was chosen.')
  return credentialJSON(cred as PublicKeyCredential)
}

/** Plain-language message, or null when the person simply closed the prompt. */
export function passkeyError(error: unknown): string | null {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return null
    if (error.name === 'InvalidStateError') return 'This device already has a passkey for this account.'
    if (error.name === 'SecurityError') return 'Passkeys need a secure (https) address for this server.'
  }
  return error instanceof Error ? error.message : 'The passkey did not work. Try again or use your password.'
}
