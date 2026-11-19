import type { ExtensionId } from '../../shared/extensions'
import type { Tool } from '../mcp/tool'
import { printerAccessTools } from './printer-access/tools'
import { availableExtensions } from './state'

const EXTENSION_TOOLS: { extension: ExtensionId; tools: Tool[] }[] = [{ extension: 'printer-access', tools: printerAccessTools }]

/** Tools of the extensions available on this instance; each still refuses to run where its extension is off. */
export async function extensionTools(env: Env): Promise<Tool[]> {
  const available = await availableExtensions(env)
  return EXTENSION_TOOLS.filter((e) => available.has(e.extension)).flatMap((e) => e.tools)
}
