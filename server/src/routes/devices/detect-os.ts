export type DeviceChoice = 'mac' | 'windows' | 'linux' | 'pi' | 'mobile'

/** Best guess at the device this browser runs on; iPhones and iPads guess the app, other phones get no guess. */
export function detectChoice(): DeviceChoice | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const ua = navigator.userAgent.toLowerCase()
  const platform = (nav.userAgentData?.platform || ua).toLowerCase()
  if (/iphone|ipad|ipod/.test(`${platform} ${ua}`)) return 'mobile'
  if (/android|cros/.test(`${platform} ${ua}`)) return null
  // iPadOS reports itself as a Mac; touch support gives it away.
  if (platform.includes('mac')) return navigator.maxTouchPoints > 1 ? 'mobile' : 'mac'
  if (platform.includes('win')) return 'windows'
  if (platform.includes('linux') || platform.includes('x11')) return 'linux'
  return null
}

export const CHOICE_LABELS: Record<DeviceChoice, string> = {
  mac: 'Mac',
  windows: 'Windows PC',
  linux: 'Linux computer',
  pi: 'Raspberry Pi',
  mobile: 'iPhone or iPad',
}
