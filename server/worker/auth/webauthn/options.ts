import { b64url, utf8 } from '../../lib/encoding'
import { SUPPORTED_ALGS } from './keys'

export interface CredentialDescriptor {
  type: 'public-key'
  id: string
  transports?: string[]
}

const TIMEOUT_MS = 300_000

/** `PublicKeyCredentialCreationOptionsJSON` for `PublicKeyCredential.parseCreationOptionsFromJSON`. */
export function creationOptions(p: {
  challenge: string
  rpId: string
  rpName: string
  userId: string
  userName: string
  displayName: string
  exclude: CredentialDescriptor[]
}) {
  return {
    challenge: p.challenge,
    rp: { id: p.rpId, name: p.rpName },
    user: { id: b64url(utf8(p.userId)), name: p.userName, displayName: p.displayName },
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: TIMEOUT_MS,
    attestation: 'none' as const,
    authenticatorSelection: { residentKey: 'required' as const, requireResidentKey: true, userVerification: 'required' as const },
    excludeCredentials: p.exclude,
    extensions: { credProps: true },
  }
}

/** `PublicKeyCredentialRequestOptionsJSON`; an empty allow list enables discoverable and autofill sign-in. */
export function requestOptions(p: { challenge: string; rpId: string; allow: CredentialDescriptor[] }) {
  return {
    challenge: p.challenge,
    rpId: p.rpId,
    timeout: TIMEOUT_MS,
    userVerification: 'required' as const,
    allowCredentials: p.allow,
  }
}
