/** One refusal the guard made. */
export type Denial = { at: number; rule: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'rule-guard': { denials: Shaped<Denial[]> }
  }
}
