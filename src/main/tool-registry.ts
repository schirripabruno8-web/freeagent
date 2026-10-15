import type { ToolDef } from '@contracts/agent'
import { bashTool } from './bash'
import { editTool } from './tools/edit'
import { globTool } from './tools/glob'
import { grepTool } from './tools/grep'
import { readTool } from './tools/read'
import { renderTool } from './tools/render'
import { writeTool } from './tools/write'

/** Every tool the agent can call (`finish` is added by the loop). */
export const allTools: ToolDef[] = [readTool, globTool, grepTool, writeTool, editTool, bashTool, renderTool]
