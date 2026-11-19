import type { Tool } from '../tool'
import { deviceTools } from './devices'
import { jobTools } from './jobs'
import { printerTools } from './printers'
import { setupTool } from './setup'
import { accountTools, instanceTools, workspaceTools } from './workspaces'

/** A fixed order, so tools/list is deterministic. */
export const TOOLS: Tool[] = [setupTool, ...accountTools, ...workspaceTools, ...deviceTools, ...printerTools, ...jobTools, ...instanceTools]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
