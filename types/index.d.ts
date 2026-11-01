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

export type Todo = { items: TodoItem[] }

declare module 'claude-code' {
  interface PluginState {
    'session-deck': {
      deck: Shaped<Deck | null>
      history: Shaped<number[]>
      todo: Shaped<Todo | null>
      spend: Shaped<Spend | null>
      warned: boolean
    }
  }
}
