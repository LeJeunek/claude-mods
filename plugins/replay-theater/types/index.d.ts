export type Kind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'other'

export type Status = 'running' | 'ok' | 'error' | 'denied'

export type Scene = {
  id: string
  act: number
  tool: string
  kind: Kind
  title: string
  subject: string
  detail: string
  at: number
  durationMs: number | null
  status: Status
  diff: string | null
  code: string | null
  codePath: string | null
  codeLanguage: string | null
  output: string | null
  isSubagent: boolean
  // The subagent whose loop made the call; null (or absent, in older recordings) for the main loop.
  agentId?: string | null
}

export type Act = { n: number; prompt: string; at: number }

export type AgentState = 'running' | 'done' | 'failed' | 'stopped'

// A subagent seen this session: one swimlane of the replay.
export type Cast = {
  id: string
  type: string
  description: string
  parentId: string | null
  state: AgentState
  startedAt: number
  endedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      scenes: Scene[]
      acts: Act[]
      cast: Cast[]
      cursor: number
      isPlaying: boolean
      speed: number
      isClosed: boolean
    }
  }
}
