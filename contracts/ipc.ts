import type { AgentEvent } from './agent'
import type { HistoryEntry, HistoryMeta } from './history'
import type { McpCandidate, McpListing, McpNewServer, McpProbeResult } from './mcp'
import type { ModelEntry, UsageInfo } from './models'
import type { PonytailMode, SkillInfo } from './skills'
import type { ApprovalRequest, CheckpointInfo, PermissionMode } from './permissions'
import type { ModelInfo } from './provider'

export interface ProviderInfo {
  id: string
  label: string
  /** config/selectors/<id>.json exists and is valid. Without it the provider cannot run: capture it with `npm run inspect -- <id>`. */
  ready: boolean
  /** The selectors describe a model picker, so a model can be chosen and the page's models listed. */
  modelPicker: boolean
}

/** The only surface the renderer sees (exposed by the preload through contextBridge). */
export interface RendererApi {
  listProviders(): Promise<ProviderInfo[]>
  /** Native folder chooser. null if cancelled. */
  pickFolder(defaultPath?: string): Promise<string | null>
  /** Docks that provider's browser view next to the UI so the user can log in by hand. */
  showProvider(id: string): Promise<void>
  /** Native image chooser (up to 4, 10 MB each). Only paths returned here can be sent with startTask. */
  pickImages(): Promise<string[]>
  /** `images` go with the main agent's first message (the provider needs `attach` selectors). */
  /** `resume`: a follow-up in the chat the provider view shows now (no new chat), to correct or extend the last result. */
  startTask(task: string, opts: { provider: string; cwd: string; model?: string; images?: string[]; resume?: boolean }): Promise<void>
  stopTask(): Promise<void>
  /** Returns an unsubscribe function. */
  onEvent(cb: (e: AgentEvent) => void): () => void
  /** The editable registry (config/models.json). */
  listModels(): Promise<ModelEntry[]>
  /** The models the provider's own page offers right now (needs a model picker in its selectors and a logged-in page). */
  listPageModels(providerId: string): Promise<ModelInfo[]>
  getUsage(): Promise<Record<string, UsageInfo>>
  /** Docks the browser view of a running sub-agent, to watch its chat. Ignored if it already finished. */
  showSession(agentId: string): Promise<void>
  listSkills(): Promise<SkillInfo[]>
  /** The always-on ponytail level. Typing `/ponytail ultra` or `stop ponytail` as the task does the same. */
  getPonytail(): Promise<PonytailMode>
  setPonytail(mode: PonytailMode): Promise<void>
  /** Every configured MCP server (config/mcp.json and the ones added from the app), on or off, with running instances and queues. */
  listMcp(): Promise<McpListing>
  /** Closes every instance of the server; the next call starts a fresh one. */
  restartMcp(name: string): Promise<void>
  openMcpConfig(): Promise<void>
  /** Opens the file of the servers added from the app (created empty if it does not exist yet). */
  openMcpUserFile(): Promise<void>
  /** Reads what the user pasted (JSON of another app, a command, `claude mcp add`, a url). Nothing is started or saved. */
  parseMcp(text: string): Promise<{ candidates: McpCandidate[]; error?: string }>
  /** Saves servers to the user's file; they start switched on. Not while a task runs. Throws with the reason if one is not valid. */
  addMcp(servers: McpNewServer[]): Promise<string[]>
  /** Switches a server on or off for every agent. Not while a task runs. */
  setMcpEnabled(name: string, enabled: boolean): Promise<void>
  /** Removes a server added from the app (an included one can only be switched off). Not while a task runs. */
  removeMcp(name: string): Promise<void>
  /** Starts the server alone, lists its tools and stops it. Works for a switched-off server too. Not while a task runs. */
  testMcp(name: string): Promise<McpProbeResult>
  getMode(): Promise<PermissionMode>
  setMode(mode: PermissionMode): Promise<void>
  /** The agent is waiting for this: the UI must show it and answer (answerApproval), or Stop the task. */
  onApproval(cb: (r: ApprovalRequest) => void): () => void
  answerApproval(id: string, allow: boolean): Promise<void>
  listCheckpoints(): Promise<CheckpointInfo[]>
  /** Rewinds every change from the newest checkpoint back to and including this one. */
  restoreCheckpoint(id: string): Promise<{ restored: string[] }>
  /** Past chats, most recent first. */
  listHistory(): Promise<HistoryMeta[]>
  loadHistory(id: string): Promise<HistoryEntry | null>
  deleteHistory(id: string): Promise<void>
  /** Shows the provider's page of that chat (so "Continua" goes on there). Not while a task runs. */
  openHistory(id: string): Promise<HistoryMeta>
}

export const IPC = {
  listProviders: 'fa:listProviders',
  listMcp: 'fa:listMcp',
  restartMcp: 'fa:restartMcp',
  openMcpConfig: 'fa:openMcpConfig',
  openMcpUserFile: 'fa:openMcpUserFile',
  parseMcp: 'fa:parseMcp',
  addMcp: 'fa:addMcp',
  setMcpEnabled: 'fa:setMcpEnabled',
  removeMcp: 'fa:removeMcp',
  testMcp: 'fa:testMcp',
  listSkills: 'fa:listSkills',
  getPonytail: 'fa:getPonytail',
  setPonytail: 'fa:setPonytail',
  showSession: 'fa:showSession',
  listModels: 'fa:listModels',
  listPageModels: 'fa:listPageModels',
  getUsage: 'fa:getUsage',
  pickFolder: 'fa:pickFolder',
  showProvider: 'fa:showProvider',
  startTask: 'fa:startTask',
  pickImages: 'fa:pickImages',
  stopTask: 'fa:stopTask',
  event: 'fa:event',
  getMode: 'fa:getMode',
  setMode: 'fa:setMode',
  approval: 'fa:approval',
  answerApproval: 'fa:answerApproval',
  listCheckpoints: 'fa:listCheckpoints',
  restoreCheckpoint: 'fa:restoreCheckpoint',
  listHistory: 'fa:listHistory',
  loadHistory: 'fa:loadHistory',
  deleteHistory: 'fa:deleteHistory',
  openHistory: 'fa:openHistory'
} as const
