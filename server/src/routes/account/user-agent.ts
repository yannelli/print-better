const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chromebook'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

const pick = (ua: string, table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1]

/** "Chrome on Mac" style summary; falls back to whatever part is recognisable. */
export function describeAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device'
  const browser = pick(ua, BROWSERS)
  const system = pick(ua, SYSTEMS)
  if (browser && system) return `${browser} on ${system}`
  return browser ?? system ?? 'Unknown device'
}

export const thisDeviceName = () => describeAgent(navigator.userAgent)
