/** What one helper (subagent) has used. */
export type Helper = {
  label: string
  model: string
  status: 'running' | 'done'
  startedAt: number
  endedAt?: number
  calls: number
  /** Context re-sent and served by the prompt cache. */
  resent: number
  /** Tokens written to the cache. */
  written: number
  /** Input the cache did not cover. */
  fresh: number
  output: number
}

/** What happened to one file. */
export type FileAct = {
  reads: number
  edits: number
  plus: number
  minus: number
  /** Who touched it, newest last: "main" or a helper's label. */
  by: string[]
  last: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-watch': {
      helpers: Shaped<Record<string, Helper>>
      files: Shaped<Record<string, FileAct>>
    }
  }
}
