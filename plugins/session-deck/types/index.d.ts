export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Pr = {
  number: number
  title: string
  branch: string
  isDraft: boolean
  review?: string
}

export type Deck = {
  model: string
  percent: number
  tokens: number
  window: number
  usd?: number
  /** Cost the last turn added, in US dollars. */
  turnUsd?: number
  limits: Limit[]
  dir: string
  /** Current branch, or null outside a git repository. */
  branch: string | null
  /** Worktree folder name when the session runs in a linked worktree. */
  worktree: string | null
  /** Files with uncommitted changes. */
  changes: number
  /** Open PRs, null when not fetched or unavailable. */
  prs: Pr[] | null
  prsNote?: string
}

export type TodoItem = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
}

/** Tokens one message cost, summed over every model request it made. */
export type Spend = {
  calls: number
  /** Context sent again and served by the prompt cache (cheap). */
  resent: number
  /** Tokens written to the cache. */
  written: number
  /** Input the cache did not cover. */
  fresh: number
  output: number
}

/** A session's spend in total: the per-message Spend summed, with a count. */
export type Totals = Spend & { messages: number }

/** The costliest message so far. */
export type Peak = { usd: number; calls: number; resent: number }

/** One row of what occupies the context window. */
export type Fill = { name: string; tokens: number }

/** What one subagent has used, from its own model requests. */
export type AgentStat = {
  model: string
  /** What its next request re-sends. */
  tokens: number
  calls: number
  resent: number
  fresh: number
  output: number
}

export type Todo = { items: TodoItem[] }

declare module 'claude-code' {
  interface PluginState {
    'session-deck': {
      deck: Shaped<Deck | null>
      history: Shaped<number[]>
      todo: Shaped<Todo | null>
      spend: Shaped<Spend | null>
      totals: Shaped<Totals | null>
      lastAt: number | null
      agents: Shaped<Record<string, AgentStat>>
      fill: Shaped<Fill[] | null>
      seenTtl: '5m' | '1h' | null
      peak: Shaped<Peak | null>
      warned: boolean
    }
  }
}
