export type DeviceChoice = 'mac' | 'windows' | 'linux' | 'pi'

/** Best guess at the computer this browser runs on; phones and tablets get no guess. */
export function detectChoice(): DeviceChoice | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const ua = navigator.userAgent.toLowerCase()
  const platform = (nav.userAgentData?.platform || ua).toLowerCase()
  if (/android|iphone|ipad|ipod|cros/.test(`${platform} ${ua}`)) return null
  // iPadOS reports itself as a Mac; touch support gives it away.
  if (platform.includes('mac')) return navigator.maxTouchPoints > 1 ? null : 'mac'
  if (platform.includes('win')) return 'windows'
  if (platform.includes('linux') || platform.includes('x11')) return 'linux'
  return null
}

export const CHOICE_LABELS: Record<DeviceChoice, string> = {
  mac: 'Mac',
  windows: 'Windows PC',
  linux: 'Linux computer',
  pi: 'Raspberry Pi',
}
