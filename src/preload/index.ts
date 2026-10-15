import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent } from '@contracts/agent'
import { IPC, type RendererApi } from '@contracts/ipc'
import type { ApprovalRequest } from '@contracts/permissions'

const subscribe =
  <T>(channel: string) =>
  (cb: (v: T) => void): (() => void) => {
    const h = (_e: unknown, v: T): void => cb(v)
    ipcRenderer.on(channel, h)
    return () => void ipcRenderer.removeListener(channel, h)
  }

const api: RendererApi = {
  listProviders: () => ipcRenderer.invoke(IPC.listProviders),
  listModels: () => ipcRenderer.invoke(IPC.listModels),
  listPageModels: (id) => ipcRenderer.invoke(IPC.listPageModels, id),
  getUsage: () => ipcRenderer.invoke(IPC.getUsage),
  showSession: (id) => ipcRenderer.invoke(IPC.showSession, id),
  listSkills: () => ipcRenderer.invoke(IPC.listSkills),
  getPonytail: () => ipcRenderer.invoke(IPC.getPonytail),
  setPonytail: (m) => ipcRenderer.invoke(IPC.setPonytail, m),
  listMcp: () => ipcRenderer.invoke(IPC.listMcp),
  restartMcp: (name) => ipcRenderer.invoke(IPC.restartMcp, name),
  openMcpConfig: () => ipcRenderer.invoke(IPC.openMcpConfig),
  openMcpUserFile: () => ipcRenderer.invoke(IPC.openMcpUserFile),
  parseMcp: (text) => ipcRenderer.invoke(IPC.parseMcp, text),
  addMcp: (servers) => ipcRenderer.invoke(IPC.addMcp, servers),
  setMcpEnabled: (name, enabled) => ipcRenderer.invoke(IPC.setMcpEnabled, name, enabled),
  removeMcp: (name) => ipcRenderer.invoke(IPC.removeMcp, name),
  testMcp: (name) => ipcRenderer.invoke(IPC.testMcp, name),
  pickFolder: (defaultPath) => ipcRenderer.invoke(IPC.pickFolder, defaultPath),
  pickImages: () => ipcRenderer.invoke(IPC.pickImages),
  showProvider: (id) => ipcRenderer.invoke(IPC.showProvider, id),
  startTask: (task, opts) => ipcRenderer.invoke(IPC.startTask, task, opts),
  stopTask: () => ipcRenderer.invoke(IPC.stopTask),
  onEvent: subscribe<AgentEvent>(IPC.event),
  getMode: () => ipcRenderer.invoke(IPC.getMode),
  setMode: (mode) => ipcRenderer.invoke(IPC.setMode, mode),
  onApproval: subscribe<ApprovalRequest>(IPC.approval),
  answerApproval: (id, allow) => ipcRenderer.invoke(IPC.answerApproval, id, allow),
  listCheckpoints: () => ipcRenderer.invoke(IPC.listCheckpoints),
  restoreCheckpoint: (id) => ipcRenderer.invoke(IPC.restoreCheckpoint, id),
  listHistory: () => ipcRenderer.invoke(IPC.listHistory),
  loadHistory: (id) => ipcRenderer.invoke(IPC.loadHistory, id),
  deleteHistory: (id) => ipcRenderer.invoke(IPC.deleteHistory, id),
  openHistory: (id) => ipcRenderer.invoke(IPC.openHistory, id)
}
contextBridge.exposeInMainWorld('api', api)
