import type { Register } from 'claude-code'

// Commands whose text becomes a commit message, PR text or tag message.
const WRITES_TEXT = /\b(git\s+(commit|tag|merge|notes)|gh\s+(pr|issue|release)\s+(create|edit|comment|merge))\b/

// Attribution lines an AI tool appends on its own.
const ATTRIBUTION = [
  /co-authored-by:\s*claude/i,
  /generated\s+with\s+\[?claude\s*code/i,
  /🤖\s*generated\s+with/i,
]

// Commands that are hard to undo. Each has a name for the question asked.
const DESTRUCTIVE: { name: string; test: RegExp }[] = [
  { name: 'rm -rf on a broad target', test: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive\s+--force)\s+(\/|~|\$HOME|\*|\.\s*$|\.\/?\*)(\s|$)/ },
  { name: 'git push --force', test: /\bgit\s+push\b[^|;&]*\s(--force(?!-with-lease)|-f)(\s|$)/ },
  { name: 'git reset --hard', test: /\bgit\s+reset\s+--hard\b/ },
  { name: 'git clean -f', test: /\bgit\s+clean\s+-[a-z]*f/ },
  { name: 'DROP TABLE / DATABASE', test: /\bdrop\s+(table|database)\b/i },
  { name: 'chmod -R 777', test: /\bchmod\s+-R\s+777\b/ },
]

export const register: Register = (on, options) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command

    if (options.blockAiAttribution !== false && WRITES_TEXT.test(command)) {
      const hit = ATTRIBUTION.find(re => re.test(command))
      if (hit !== undefined) {
        return {
          deny: 'rule-guard: remove the AI attribution line (Co-Authored-By: Claude / Generated with Claude Code) from this command, then run it again.',
        }
      }
    }

    const pattern = typeof options.customDenyPattern === 'string' ? options.customDenyPattern.trim() : ''
    if (pattern !== '') {
      let re: RegExp | null = null
      try {
        re = new RegExp(pattern)
      } catch {
        re = null
      }
      if (re !== null && re.test(command)) {
        const scope = typeof options.customDenyScope === 'string' ? options.customDenyScope : ''
        const folders = scope.split(',').map(s => s.trim()).filter(Boolean)
        const cwd = await $.session.cwd()
        // A fragment of the session folder's path: a name or a part of the path.
        const isInScope = folders.length === 0 || folders.some(f => cwd.includes(f))
        if (isInScope) {
          const why = typeof options.customDenyMessage === 'string' && options.customDenyMessage !== ''
            ? options.customDenyMessage
            : 'This command matches a pattern you blocked.'
          return { deny: `rule-guard: ${why}` }
        }
      }
    }

    if (options.confirmDestructive !== false) {
      const risky = DESTRUCTIVE.find(r => r.test.test(command))
      if (risky !== undefined) {
        let answer = 'Cancel'
        try {
          answer = await $.ui.ask(
            `This command looks destructive (${risky.name}): ${command.slice(0, 160)}. Run it?`,
            ['Run it', 'Cancel'],
          )
        } catch {
          answer = 'Cancel'
        }
        if (answer !== 'Run it') {
          return { deny: `rule-guard: not run. ${risky.name} needs your OK and it was not given.` }
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'rule-guard: its check failed, so the command was not run.' }))
}
