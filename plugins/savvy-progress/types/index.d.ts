export type Kind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'other'

export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = { content: string; status: StepStatus }

export type Outcome = 'answer' | 'aborted' | 'refusal' | 'error'

export type AgentState = 'running' | 'done' | 'failed' | 'stopped'

export type CallStatus = 'running' | 'ok' | 'error' | 'denied'

// The part an agent plays, read from its type and task; its critter dresses for it.
export type Role =
  | 'researcher'
  | 'frontend'
  | 'backend'
  | 'designer'
  | 'tester'
  | 'planner'
  | 'reviewer'
  | 'writer'
  | 'devops'
  | 'debugger'
  | 'security'
  | 'generalist'

// One tool call an agent made: what it was, on what, and how it went.
export type AgentCall = {
  id: string
  tool: string
  kind: Kind
  target: string
  status: CallStatus
  startedAt: number
  durationMs: number | null
}

// One subagent (or teammate) and what it is doing. Fields added after the first
// release are optional, so a roster written by an earlier load still reads.
export type AgentLive = {
  id: string
  parentId: string | null
  type: string
  description: string
  isBackground: boolean
  state: AgentState
  activity: string
  kind: Kind
  tools: number
  running: number
  trail: Kind[]
  startedAt: number
  endedAt: number | null
  model?: string | null
  effort?: string | null
  tokens?: number
  costUsd?: number | null
  steps?: PlanStep[]
  color?: number
  typicalMs?: number | null
  group?: string
  role?: Role
  calls?: AgentCall[]
  toolCounts?: Record<string, number>
}

export type Progress = {
  isWorking: boolean
  startedAt: number
  endedAt: number | null
  tools: number
  running: number
  failures: number
  activity: string
  kind: Kind
  filesChanged: string[]
  plan: PlanStep[]
  typicalMs: number | null
  outputTokens: number | null
  outcome: Outcome | null
  agents?: AgentLive[]
  prompt?: string
  // The turn's own tool calls, for the band's overview: a tally, the latest calls, and new files.
  toolCounts?: Record<string, number>
  actions?: AgentCall[]
  filesCreated?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      progress: Progress | null
      isHidden: boolean
      // The band opened up to list every plan step.
      isExpanded: boolean
      now: number
      agentsClosed: boolean
      // Agent cards whose Tools list is open.
      openCards: string[]
      // Overview tiles (steps, tools, files, agents) opened to their full lists.
      openTiles: string[]
    }
  }
}
