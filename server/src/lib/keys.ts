/** The modifier key for shortcuts such as ⌘K, as this device labels it. */
export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'
