import type { ExtensionId } from '../../shared/extensions'
import { USAGE_EXTENSIONS } from '../../shared/usage'
import type { Schema, Tool } from '../mcp/tool'
import { enterpriseToolArguments, enterpriseTools } from './enterprise/tools'
import { printPolicyTools } from './print-policies/tools'
import { printerAccessTools } from './printer-access/tools'
import { availableExtensions } from './state'
import { usageTools } from './usage/tools'

const EXTENSION_TOOLS: { extension: ExtensionId; tools: Tool[] }[] = [
  { extension: 'printer-access', tools: printerAccessTools },
  ...USAGE_EXTENSIONS.map((extension) => ({ extension, tools: usageTools })),
  { extension: 'print-policies', tools: printPolicyTools },
  { extension: 'enterprise', tools: enterpriseTools },
]

/** Arguments an extension adds to another tool while it is available, e.g. `costCenter` on `print`. */
export interface ToolArguments {
  extension: ExtensionId
  tool: string
  /** Merged over the tool's own properties, so one can also widen an existing argument. */
  properties: Record<string, Schema>
}

export const EXTENSION_TOOL_ARGUMENTS: ToolArguments[] = [...enterpriseToolArguments]

/** A tool with the arguments that available extensions add to it. */
function widened(tool: Tool, available: ReadonlySet<ExtensionId>): Tool {
  const extra = EXTENSION_TOOL_ARGUMENTS.filter((a) => a.tool === tool.name && available.has(a.extension))
  if (extra.length === 0) return tool
  const properties = Object.assign({}, tool.inputSchema.properties, ...extra.map((a) => a.properties))
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } }
}

/** The core tools, then the extensions' own tools, as available extensions widen them. Shared tools are listed once. */
export async function availableTools(env: Env, core: readonly Tool[]): Promise<Tool[]> {
  const available = await availableExtensions(env)
  const tools = [...core, ...EXTENSION_TOOLS.filter((e) => available.has(e.extension)).flatMap((e) => e.tools)]
  return tools.filter((t, i) => tools.findIndex((other) => other.name === t.name) === i).map((t) => widened(t, available))
}

/** Whether finding `name` needs the instance's extensions: an extension tool, or a core tool they may widen. */
export const needsExtensions = (name: string, core: ReadonlyMap<string, Tool>): boolean =>
  !core.has(name) || EXTENSION_TOOL_ARGUMENTS.some((a) => a.tool === name)
