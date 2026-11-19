import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conditionalMediationAvailable, createPasskey, getPasskey, passkeyError, passkeysSupported } from './webauthn'

class AttestationResponse {
  clientDataJSON = new Uint8Array([123, 125]).buffer
  attestationObject = new Uint8Array([0xff, 0xfe, 0xfd]).buffer
  getTransports = () => ['internal', 'hybrid']
  getPublicKeyAlgorithm = () => -7
  getPublicKey = () => new Uint8Array([1]).buffer
  getAuthenticatorData = () => new Uint8Array([2, 3]).buffer
}

class AssertionResponse {
  clientDataJSON = new Uint8Array([1]).buffer
  authenticatorData = new Uint8Array([4, 5, 6]).buffer
  signature = new Uint8Array([0xfb, 0xff]).buffer
  userHandle = null
}

const credential = (response: object, toJSON?: () => unknown) => ({
  id: 'cred-1',
  rawId: new Uint8Array([0xff, 0xee]).buffer,
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response,
  getClientExtensionResults: () => ({ credProps: { rk: true } }),
  ...(toJSON ? { toJSON } : {}),
})

const bytes = (buffer: unknown) => [...new Uint8Array(buffer as ArrayBuffer)]

let create: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn>

/** Simulates a browser without the JSON helpers (Safari before 18.4) unless `native` is given. */
function browser(native?: { parseCreationOptionsFromJSON: unknown; parseRequestOptionsFromJSON: unknown }) {
  const PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, native, {
    isConditionalMediationAvailable: async () => true,
  })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('PublicKeyCredential', PublicKeyCredential)
  vi.stubGlobal('AuthenticatorAttestationResponse', AttestationResponse)
  vi.stubGlobal('AuthenticatorAssertionResponse', AssertionResponse)
  vi.stubGlobal('navigator', { credentials: { create, get } })
}

beforeEach(() => {
  create = vi.fn(async () => credential(new AttestationResponse()))
  get = vi.fn(async () => credential(new AssertionResponse()))
  browser()
})
afterEach(() => vi.unstubAllGlobals())

const creationJSON = {
  rp: { id: 'print.example.com', name: 'Print Better' },
  user: { id: 'AQID', name: 'margaret', displayName: 'Margaret' },
  challenge: '-_8',
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [{ type: 'public-key', id: '_w' }],
} as PublicKeyCredentialCreationOptionsJSON

describe('creating a passkey without native JSON support', () => {
  it('decodes base64url fields into bytes', async () => {
    await createPasskey(creationJSON)
    const { publicKey } = create.mock.calls[0][0] as { publicKey: PublicKeyCredentialCreationOptions }
    expect(bytes(publicKey.challenge)).toEqual([0xfb, 0xff])
    expect(bytes(publicKey.user.id)).toEqual([1, 2, 3])
    expect(bytes(publicKey.excludeCredentials![0].id)).toEqual([0xff])
    expect(publicKey.rp).toEqual(creationJSON.rp)
  })

  it('serialises the attestation as unpadded base64url JSON', async () => {
    expect(await createPasskey(creationJSON)).toEqual({
      id: 'cred-1',
      rawId: '_-4',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: 'e30',
        attestationObject: '__79',
        transports: ['internal', 'hybrid'],
        publicKeyAlgorithm: -7,
        publicKey: 'AQ',
        authenticatorData: 'AgM',
      },
    })
  })
})

describe('signing in with a passkey', () => {
  const requestJSON = { challenge: 'AAEC', allowCredentials: [{ type: 'public-key', id: 'BAU' }] } as PublicKeyCredentialRequestOptionsJSON

  it('decodes the request and serialises the assertion', async () => {
    const json = await getPasskey(requestJSON)
    const options = get.mock.calls[0][0] as CredentialRequestOptions
    expect(bytes(options.publicKey!.challenge)).toEqual([0, 1, 2])
    expect(bytes(options.publicKey!.allowCredentials![0].id)).toEqual([4, 5])
    expect(options.mediation).toBe('optional')
    expect(json).toMatchObject({ response: { clientDataJSON: 'AQ', authenticatorData: 'BAUG', signature: '-_8', userHandle: undefined } })
  })

  it('asks for autofill with the abort signal for conditional mediation', async () => {
    const controller = new AbortController()
    await getPasskey(requestJSON, { conditional: true, signal: controller.signal })
    expect(get.mock.calls[0][0]).toMatchObject({ mediation: 'conditional', signal: controller.signal })
  })

  it('fails clearly when the browser returns nothing', async () => {
    get.mockResolvedValueOnce(null)
    await expect(getPasskey(requestJSON)).rejects.toThrow('No passkey was chosen.')
  })
})

describe('native JSON support', () => {
  it('prefers parse*FromJSON and credential.toJSON when present', async () => {
    const parsed = { challenge: new ArrayBuffer(1) }
    const native = { parseCreationOptionsFromJSON: vi.fn(() => parsed), parseRequestOptionsFromJSON: vi.fn(() => parsed) }
    browser(native)
    create.mockResolvedValueOnce(credential(new AttestationResponse(), () => ({ native: true })))
    expect(await createPasskey(creationJSON)).toEqual({ native: true })
    expect(native.parseCreationOptionsFromJSON).toHaveBeenCalledWith(creationJSON)
    expect(create.mock.calls[0][0]).toEqual({ publicKey: parsed })
  })
})

describe('support checks and errors', () => {
  it('detects passkeys and conditional mediation', async () => {
    expect(passkeysSupported()).toBe(true)
    await expect(conditionalMediationAvailable()).resolves.toBe(true)
    vi.stubGlobal('PublicKeyCredential', undefined)
    expect(passkeysSupported()).toBe(false)
    await expect(conditionalMediationAvailable()).resolves.toBe(false)
  })

  it('stays quiet when the person closes the prompt and explains real problems', () => {
    expect(passkeyError(new DOMException('x', 'NotAllowedError'))).toBeNull()
    expect(passkeyError(new DOMException('x', 'AbortError'))).toBeNull()
    expect(passkeyError(new DOMException('x', 'InvalidStateError'))).toMatch(/already has a passkey/)
    expect(passkeyError(new DOMException('x', 'SecurityError'))).toMatch(/https/)
    expect(passkeyError(new Error('Server said no'))).toBe('Server said no')
  })
})
