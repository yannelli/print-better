import { useCallback, useEffect, useRef, useState } from 'react'
import { authApi } from '@/lib/api/auth'
import { errorMessage } from '@/lib/api/http'
import { conditionalMediationAvailable, getPasskey, passkeyError, passkeysSupported } from '@/lib/webauthn'

/** Autofill passkey request while the form is open; `signInNow` cancels it first since only one may be pending. */
export function usePasskeyLogin(onSignedIn: () => Promise<void>) {
  const autofill = useRef<AbortController | null>(null)
  const signedIn = useRef(onSignedIn)
  signedIn.current = onSignedIn
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = passkeysSupported()

  const finish = useCallback(
    async (challengeId: string, credential: unknown) => {
      setPending(true)
      try {
        await authApi.passkeyLoginVerify(challengeId, credential)
        await signedIn.current()
      } finally {
        setPending(false)
      }
    },
    [],
  )

  useEffect(() => {
    const controller = new AbortController()
    autofill.current = controller
    // Autofill runs in the background: only a passkey the person actually picked may report an error.
    const start = async () => {
      if (!(await conditionalMediationAvailable()) || controller.signal.aborted) return
      const { challengeId, options } = await authApi.passkeyLoginOptions()
      const credential = await getPasskey(options, { conditional: true, signal: controller.signal })
      await finish(challengeId, credential).catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e))
      })
    }
    start().catch(() => undefined)
    return () => controller.abort()
  }, [finish])

  const cancelAutofill = useCallback(() => autofill.current?.abort(), [])

  const signInNow = useCallback(
    async (login?: string) => {
      cancelAutofill()
      setError(null)
      setPending(true)
      try {
        const { challengeId, options } = await authApi.passkeyLoginOptions(login || undefined)
        const credential = await getPasskey(options)
        await finish(challengeId, credential)
      } catch (e) {
        setError(e instanceof DOMException ? passkeyError(e) : errorMessage(e))
      } finally {
        setPending(false)
      }
    },
    [cancelAutofill, finish],
  )

  return { supported, pending, error, signInNow, cancelAutofill }
}
