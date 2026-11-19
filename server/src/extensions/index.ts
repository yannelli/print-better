import { enterpriseUi } from './enterprise'
import type { ExtensionUi } from './registry'
import { printPoliciesUi } from './print-policies'
import { printerAccessUi } from './printer-access'
import { usageUi } from './usage'

/** Web UI of every extension. Its slots render only where the extension is active. */
export const EXTENSION_UI: readonly ExtensionUi[] = [printerAccessUi, usageUi, printPoliciesUi, enterpriseUi]
