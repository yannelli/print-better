import type { ExtensionId } from '../../shared/extensions'
import type { Schema, Tool } from '../mcp/tool'
import { printerAccessTools } from './printer-access/tools'
import { availableExtensions } from './state'

const EXTENSION_TOOLS: { extension: ExtensionId; tools: Tool[] }[] = [{ extension: 'printer-access', tools: printerAccessTools }]

/** Arguments an extension adds to a core tool while it is available, e.g. `costCenter` on `print`. */
export interface ToolArguments {
  extension: ExtensionId
  tool: string
  /** Merged over the tool's own properties, so one can also widen an existing argument. */
  properties: Record<string, Schema>
}

export const EXTENSION_TOOL_ARGUMENTS: ToolArguments[] = []

/** Tools of the extensions available on this instance; each still refuses to run where its extension is off. */
export async function extensionTools(env: Env): Promise<Tool[]> {
  const available = await availableExtensions(env)
  return EXTENSION_TOOLS.filter((e) => available.has(e.extension)).flatMap((e) => e.tools)
}
