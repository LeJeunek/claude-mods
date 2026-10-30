export type Touch = {
  path: string
  reads: number
  edits: number
  isNew: boolean
  at: number
}

export type Mode = 'touched' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      touched: Touch[]
      mode: Mode
      expanded: string[]
      rev: number
      isClosed: boolean
    }
  }
}
