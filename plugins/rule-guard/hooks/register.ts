import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// What the guard refused lately, newest last, kept for the session.
const denials = atom({ plugin: 'rule-guard', key: 'denials' } as const, [], {
  shape: 'denials-1',
})

// Records a refusal and answers the tool call with it.
async function refuse($: EngineInterface, rule: string, command: string, deny: string) {
  await update($, denials, list => [...list, { at: Date.now(), rule, text: command.slice(0, 80) }].slice(-50))

  return { deny }
}

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

// The first line of the message a `git commit` command carries: from a heredoc
// ($(cat <<'EOF' ...)) or from -m "..." / -m '...'. null when it cannot be read
// (-F file, an editor, --amend with no message), so nothing is judged then.
function commitSubject(command: string): string | null {
  if (!/\bgit\s+commit\b/.test(command)) return null
  const here = /<<-?\s*['"]?\w+['"]?[ \t]*\n([^\n]*)/.exec(command)
  if (here !== null) return here[1].trim()
  const quoted = /(?:-m|--message)[ =]\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command)
  if (quoted !== null) return (quoted[1] ?? quoted[2] ?? '').split('\n')[0].trim()
  return null
}

const HANGUL = /[가-힣]/

const onOff = (v: unknown, whenUnset: boolean) => (v === undefined || v === '' ? whenUnset : v !== false)

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guard-status',
      description: 'Show which rule-guard rules are on and what they refused lately',
    })
    // The first time this mod ever loads, say how to set it up. Once.
    if (e.isInteractive && (await $.store.get('onboarded')) === undefined) {
      $.ui.log('rule-guard is on: it blocks AI attribution in commits and asks before destructive commands. Set the other rules with /plugin configure rule-guard@tailored; /guard-status shows what is on.')
      await $.store.set('onboarded', true)
    }

    return next(e)
  })

  on('command.run', { command: 'guard-status' }, async $ => {
    const list = await read($, denials)
    const has = (v: unknown) => typeof v === 'string' && v.trim() !== ''
    const rows = [
      `${onOff(options.blockAiAttribution, true) ? 'on ' : 'off'}  AI attribution in commits and PRs`,
      `${onOff(options.confirmDestructive, true) ? 'on ' : 'off'}  Ask before destructive commands`,
      `${options.requireKoreanCommit === true ? 'on ' : 'off'}  Korean commit subject`,
      `${has(options.commitSubjectPattern) ? 'on ' : 'off'}  Commit subject style${has(options.commitSubjectPattern) ? `: ${String(options.commitSubjectPattern)}` : ''}`,
      `${has(options.defaultSubagentModel) ? 'on ' : 'off'}  Subagent model${has(options.defaultSubagentModel) ? `: ${String(options.defaultSubagentModel)}` : ''}`,
      `${has(options.customDenyPattern) ? 'on ' : 'off'}  Custom block${has(options.customDenyPattern) ? `: ${String(options.customDenyPattern)}` : ''}`,
    ]
    const counts = new Map<string, number>()
    for (const d of list) counts.set(d.rule, (counts.get(d.rule) ?? 0) + 1)
    const recent = list.slice(-5).map(d => `  ${d.rule}: ${d.text}`)

    return {
      text: [
        'rule-guard rules',
        ...rows,
        '',
        list.length === 0
          ? 'Nothing refused this session.'
          : `Refused ${list.length} time${list.length === 1 ? '' : 's'} this session (${[...counts].map(([r, n]) => `${r} ${n}`).join(', ')}). Latest:`,
        ...recent,
      ].join('\n'),
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command

    if (options.blockAiAttribution !== false && WRITES_TEXT.test(command)) {
      const hit = ATTRIBUTION.find(re => re.test(command))
      if (hit !== undefined) {
        return await refuse($, 'AI attribution', command, 'rule-guard: remove the AI attribution line (Co-Authored-By: Claude / Generated with Claude Code) from this command, then run it again.')
      }
    }

    const subject = commitSubject(command)
    if (subject !== null && subject !== '') {
      if (options.requireKoreanCommit === true && !HANGUL.test(subject)) {
        return await refuse($, 'Korean commit', command, `rule-guard: write the commit subject in Korean (it has no Hangul): "${subject.slice(0, 80)}". Rewrite it and commit again.`)
      }
      const style = typeof options.commitSubjectPattern === 'string' ? options.commitSubjectPattern.trim() : ''
      if (style !== '') {
        let re: RegExp | null = null
        try {
          re = new RegExp(style)
        } catch {
          re = null
        }
        if (re !== null && !re.test(subject)) {
          return await refuse($, 'Commit style', command, `rule-guard: the commit subject must match ${style}. Got "${subject.slice(0, 80)}". Rewrite it and commit again.`)
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
          return await refuse($, 'Custom pattern', command, `rule-guard: ${why}`)
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
          return await refuse($, 'Destructive', command, `rule-guard: not run. ${risky.name} needs your OK and it was not given.`)
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'rule-guard: its check failed, so the command was not run.' }))

  // Subagents started with no model inherit the session's, often the most
  // expensive one. Give them the model you chose, except for the types you keep.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const model = options.defaultSubagentModel
    const isModel = model === 'sonnet' || model === 'haiku' || model === 'opus' || model === 'fable'
    if (!isModel || e.model !== undefined || e.subagent_type === 'fork') return next(e)

    const keep = (typeof options.subagentKeepModelFor === 'string' ? options.subagentKeepModelFor : '')
      .split(',')
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
    const type = (e.subagent_type ?? '').toLowerCase()
    if (keep.some(k => type.includes(k))) return next(e)

    return next({ ...e, model })
  })
}
