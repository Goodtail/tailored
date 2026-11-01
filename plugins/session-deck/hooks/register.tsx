import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentStat, Deck, Fill, Limit, Peak, Pr, Spend, Todo, TodoItem, Totals } from '../types'

const PANE = 'session-deck'
const MAX_HISTORY = 60
const PR_EVERY_MS = 60_000
const BLOCKS = '▁▂▃▄▅▆▇█'

// Change a tag when the shape it guards changes: it declines what an earlier
// version stored, which outlives a reload.
const deck = atom({ plugin: 'session-deck', key: 'deck' } as const, null, {
  shape: 'deck-1',
})
const history = atom({ plugin: 'session-deck', key: 'history' } as const, [], {
  shape: 'history-1',
})
const todo = atom({ plugin: 'session-deck', key: 'todo' } as const, null, {
  shape: 'todo-2',
})
const warned = atom({ plugin: 'session-deck', key: 'warned' } as const, false)

const bar = (percent: number, width: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
const spark = (list: number[]) =>
  list.map(p => BLOCKS[Math.min(7, Math.floor((p / 100) * 8))]).join('')
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))
const tone = (p: number) => (p >= 85 ? 'red' : p >= 70 ? 'yellow' : 'green')
const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path
const limitName = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind
const resets = (iso?: string) => {
  if (iso === undefined) return ''
  const ms = Date.parse(iso) - Date.now()
  if (Number.isNaN(ms) || ms <= 0) return ''
  const m = Math.round(ms / 60000)
  return m >= 60 ? ` ↻${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}` : ` ↻${m}m`
}

function progress(t: Todo | null) {
  if (t === null) return null
  const items = t.items.filter(i => i.status !== 'deleted')
  if (items.length === 0) return null
  return {
    done: items.filter(i => i.status === 'completed').length,
    total: items.length,
    current: items.find(i => i.status === 'in_progress')?.text,
  }
}

// API list prices, US dollars per million tokens (first-party API, as of
// 2026-10). `cache` is the cache-read price where it is published. A model not
// listed shows no price rather than a guess.
const PRICES: { match: RegExp; in: number; out: number; cache?: number }[] = [
  { match: /^claude-(fable|mythos)-5/, in: 10, out: 50, cache: 0.25 },
  { match: /^claude-opus-5-5/, in: 4, out: 20, cache: 0.2 },
  { match: /^claude-opus-(5|4-[678])/, in: 5, out: 25 },
  { match: /^claude-sonnet-5-5/, in: 2, out: 10, cache: 0.2 },
  { match: /^claude-sonnet-5/, in: 2, out: 10 },
  { match: /^claude-sonnet-4-6/, in: 3, out: 15 },
  { match: /^claude-haiku-5-5/, in: 0.1, out: 0.5 },
  { match: /^claude-haiku-4-5/, in: 1, out: 5 },
]

const priceOf = (id: string) => PRICES.find(r => r.match.test(id))
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}`
const priceText = (id: string) => {
  const r = priceOf(id)
  if (r === undefined) return ''
  return `per 1M: in ${usd(r.in)} · out ${usd(r.out)}${r.cache !== undefined ? ` · cache ${usd(r.cache)}` : ''}`
}

const prettyModel = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (m === null) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

const spend = atom({ plugin: 'session-deck', key: 'spend' } as const, null, {
  shape: 'spend-1',
})

// Everything the session has spent since the mod loaded, summed over messages.
const totals = atom({ plugin: 'session-deck', key: 'totals' } as const, null, {
  shape: 'totals-1',
})

// When the last model request finished: the prompt cache's clock starts there.
const lastAt = atom({ plugin: 'session-deck', key: 'lastAt' } as const, null)
// The cache lifetime the engine itself reported on the last model switch.
const seenTtl = atom({ plugin: 'session-deck', key: 'seenTtl' } as const, null)
// What fills the context window, biggest first, from the engine's own estimate.
const fill = atom({ plugin: 'session-deck', key: 'fill' } as const, null, {
  shape: 'fill-1',
})
// What each subagent has used, by agent id, so its band can show its own
// context and not the main conversation's.
const agents = atom({ plugin: 'session-deck', key: 'agents' } as const, {}, {
  shape: 'agents-1',
})
// The costliest message so far.
const peak = atom({ plugin: 'session-deck', key: 'peak' } as const, null, {
  shape: 'peak-1',
})

const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
const durationText = (ms: number) => {
  const sec = Math.round(ms / 1000)
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`
}

const homeShort = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, '~')

// The path's tail, the folders nearest the working directory first to stay.
function tailPath(path: string, max: number): string {
  const full = homeShort(path)
  if (full.length <= max) return full
  const segs = full.split('/').filter(Boolean)
  let kept = ''
  for (let i = segs.length - 1; i >= 0; i--) {
    const next = kept === '' ? segs[i] : `${segs[i]}/${kept}`
    if (next.length + 2 > max) break
    kept = next
  }
  return kept === '' ? `…${segs[segs.length - 1].slice(-(max - 1))}` : `…/${kept}`
}

const isBandOn = (o: Readonly<Record<string, unknown>>) => o.position !== 'status'
const isStatusOn = (o: Readonly<Record<string, unknown>>) =>
  o.position === 'status' || o.position === 'both'

function statusLine(d: Deck, t: Todo | null, options: Readonly<Record<string, unknown>>): string {
  const mine = d.prs?.find(p => p.branch === d.branch)
  const limit = d.limits.find(l => l.kind === 'five_hour') ?? d.limits[0]
  const parts = [
    `${prettyModel(d.model)}  ${d.percent}% ${k(d.tokens)}/${k(d.window)}`,
    limit !== undefined ? `${limitName(limit.kind)} ${limit.percent}%${resets(limit.resetsAt)}` : '',
    d.usd !== undefined ? `$${d.usd.toFixed(2)}${d.turnUsd !== undefined ? ` (+${d.turnUsd.toFixed(2)})` : ''}` : '',
    d.branch !== null
      ? `⎇ ${d.branch}${d.worktree !== null ? ` (wt ${d.worktree})` : ''}${d.changes > 0 ? ` ±${d.changes}` : ''}`
      : '',
    mine !== undefined ? `PR#${mine.number}${d.prs && d.prs.length > 1 ? `/${d.prs.length}` : ''}` : d.prs && d.prs.length > 0 ? `${d.prs.length} PRs` : '',
    options.showDirectory !== false ? tailPath(d.dir, 36) : '',
    progress(t) !== null ? `☑ ${progress(t)?.done}/${progress(t)?.total}` : '',
  ]
  return parts.filter(Boolean).join('  │  ')
}

function buildHandoff(a: {
  now: string
  dir: string
  deck: Deck | null
  todo: Todo | null
  status: string | null
  log: string | null
  note: string
}): string {
  const d = a.deck
  const items = (a.todo?.items ?? []).filter(i => i.status !== 'deleted')
  const mark = (s: TodoItem['status']) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]')
  const lines = [
    '# Handoff',
    '',
    `Written ${a.now} from \`${a.dir}\`.`,
    '',
    '## Where things stand',
    d?.branch ? `- Branch: ${d.branch}${d.worktree ? ` (worktree ${d.worktree})` : ''}` : '- Not a git repository',
    d ? `- Model: ${prettyModel(d.model)} · context ${d.percent}% (${k(d.tokens)}/${k(d.window)})` : '',
    a.status ? `- Uncommitted changes:\n${a.status.split('\n').map(l => `  - ${l}`).join('\n')}` : '- Working tree clean',
    a.log ? `- Recent commits:\n${a.log.split('\n').map(l => `  - ${l}`).join('\n')}` : '',
    d?.prs && d.prs.length > 0
      ? `- Open PRs:\n${d.prs.map(p => `  - #${p.number} ${p.title} (${p.branch})`).join('\n')}`
      : '',
    '',
    '## Todos',
    items.length === 0 ? 'None were open in the session.' : items.map(i => `- ${mark(i.status)} ${i.text}`).join('\n'),
    '',
    '## Notes from the person',
    a.note !== '' ? a.note : '(none given; add the last decision and the next step here)',
    '',
  ]
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n')
}

function briefing(d: Deck, hasHandoff: boolean): string {
  const bits = [
    d.branch !== null ? `🌿 ${d.branch}${d.worktree !== null ? ` (wt ${d.worktree})` : ''}` : '',
    d.branch !== null ? (d.changes > 0 ? `${d.changes} uncommitted` : 'clean') : '',
    d.prs !== null && d.prs.length > 0 ? `🔀 ${d.prs.length} open PR${d.prs.length === 1 ? '' : 's'}` : '',
    hasHandoff ? '📝 a handoff note is here: .claude/handoff.md' : '',
  ].filter(Boolean)
  return bits.join(' · ')
}

async function git($: EngineInterface, argv: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', ...argv], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

async function fetchPrs($: EngineInterface): Promise<{ prs: Pr[] | null; note?: string }> {
  try {
    const r = await $.process.run(
      ['gh', 'pr', 'list', '--state', 'open', '--limit', '10', '--json',
        'number,title,headRefName,isDraft,reviewDecision'],
      { timeoutMs: 15000 },
    )
    if (r.exitCode !== 0) return { prs: null, note: 'gh: no PRs (not a GitHub repo, or not signed in)' }
    const rows = JSON.parse(r.stdout) as {
      number: number
      title: string
      headRefName: string
      isDraft: boolean
      reviewDecision?: string
    }[]
    return {
      prs: rows.map(p => ({
        number: p.number,
        title: p.title,
        branch: p.headRefName,
        isDraft: p.isDraft,
        review: p.reviewDecision || undefined,
      })),
    }
  } catch {
    return { prs: null, note: 'gh (GitHub CLI) is not installed' }
  }
}

async function publish($: EngineInterface, options: Readonly<Record<string, unknown>>) {
  const d = await read($, deck)
  if (d !== null && isStatusOn(options)) {
    $.ui.status(statusLine(d, await read($, todo), options))
  }
}

let lastPrFetch = 0

const ZERO: Totals = { messages: 0, calls: 0, resent: 0, written: 0, fresh: 0, output: 0 }

let lastRefresh = 0
// The session's cost when the current message began; null before the first.
let turnBaseUsd: number | null = null

async function refresh(
  $: EngineInterface,
  options: Readonly<Record<string, unknown>>,
  force: boolean,
  isTurnEnd = false,
) {
  // A turn with many steps refreshes after each; keep git and gh calm.
  if (!force && !isTurnEnd && Date.now() - lastRefresh < 1500) return
  lastRefresh = Date.now()
  const wantsFill = isTurnEnd || force
  const usage = await $.session.usage(wantsFill ? { breakdown: 'summary' } : undefined)
  const { tokens, window, percent } = usage.context
  if (tokens === undefined || percent === undefined) return

  const [model, dir] = await Promise.all([$.session.model(), $.session.cwd()])
  const [branch, top, gitDir, common, status] = await Promise.all([
    git($, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, ['rev-parse', '--show-toplevel']),
    git($, ['rev-parse', '--absolute-git-dir']),
    git($, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git($, ['status', '--porcelain']),
  ])
  const isWorktree = gitDir !== null && common !== null && gitDir !== common
  const limits: Limit[] = usage.rateLimits.map(r => ({
    kind: r.kind,
    percent: r.percentUsed,
    resetsAt: r.resetsAt,
  }))

  const previous = await read($, deck)
  let prs = previous?.prs ?? null
  let prsNote = previous?.prsNote
  const isDue = Date.now() - lastPrFetch > PR_EVERY_MS
  if (options.showPrs !== false && branch !== null && (force || isDue)) {
    lastPrFetch = Date.now()
    const got = await fetchPrs($)
    prs = got.prs
    prsNote = got.note
  }

  const next: Deck = {
    model,
    percent,
    tokens,
    window,
    usd: usage.cost?.usd,
    // What the current (or last) message has cost so far: the session total
    // now less the total when that message began.
    turnUsd:
      usage.cost !== undefined && turnBaseUsd !== null && usage.cost.usd >= turnBaseUsd
        ? usage.cost.usd - turnBaseUsd
        : previous?.turnUsd,
    limits,
    dir,
    branch: branch === 'HEAD' ? '(detached)' : branch,
    worktree: isWorktree && top !== null ? base(top) : null,
    changes: status ? status.split('\n').filter(Boolean).length : 0,
    prs: options.showPrs === false ? null : prs,
    prsNote,
  }
  await update($, deck, () => next)
  const rows = usage.context.breakdown?.categories
  if (wantsFill && rows !== undefined) {
    const used: Fill[] = rows
      .filter(r => r.kind === 'used' && r.tokens > 0)
      .map(r => ({ name: r.name, tokens: r.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
    await update($, fill, () => used)
  }
  if (isTurnEnd || force) await update($, history, list => [...list, percent].slice(-MAX_HISTORY))
  $.ui.status(isStatusOn(options) ? statusLine(next, await read($, todo), options) : undefined)

  const warnAt = typeof options.warnPercent === 'number' ? options.warnPercent : 80
  const isWarned = await read($, warned)
  if (percent >= warnAt && !isWarned) {
    $.ui.toast(`Context ${percent}% full (${k(tokens)}/${k(window)})`)
    await update($, warned, () => true)
  } else if (percent < warnAt - 10 && isWarned) {
    await update($, warned, () => false)
  }
}

export const register: Register = (on, options) => {
  // Model requests the main loop made for the current message.
  let calls = 0
  // When the current message began, in $.clock.now()'s milliseconds.
  let turnStartedAt = 0

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      calls = 0
      turnStartedAt = await $.clock.now()
      turnBaseUsd = (await $.session.usage()).cost?.usd ?? null
      await update($, spend, () => ({ calls: 0, resent: 0, written: 0, fresh: 0, output: 0 }))
      await update($, totals, t => ({ ...(t ?? ZERO), messages: (t?.messages ?? 0) + 1 }))
    }

    return next(e)
  })

  // After each model request: add its tokens to this message's spend, and
  // refresh the figures so the band moves while Claude is still working.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (e.agentId !== undefined && res.usage !== null) {
      const id = e.agentId
      const u = res.usage
      await update($, agents, all => {
        const before = all[id]
        const stat: AgentStat = {
          model: u.model,
          // What the agent's next request re-sends.
          tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
          calls: (before?.calls ?? 0) + 1,
          resent: (before?.resent ?? 0) + u.cache_read_input_tokens,
          fresh: (before?.fresh ?? 0) + u.input_tokens + u.cache_creation_input_tokens,
          output: (before?.output ?? 0) + u.output_tokens,
        }
        const keys = Object.keys(all).filter(k => k !== id).slice(-29)
        const kept: Record<string, AgentStat> = {}
        for (const key of keys) kept[key] = all[key]
        kept[id] = stat

        return kept
      })
    }
    if (e.agentId === undefined) {
      calls += 1
      await update($, lastAt, () => Date.now())
      const u = res.usage
      await update($, spend, row => ({
        calls,
        resent: (row?.resent ?? 0) + (u?.cache_read_input_tokens ?? 0),
        written: (row?.written ?? 0) + (u?.cache_creation_input_tokens ?? 0),
        fresh: (row?.fresh ?? 0) + (u?.input_tokens ?? 0),
        output: (row?.output ?? 0) + (u?.output_tokens ?? 0),
      }))
      await update($, totals, t => ({
        messages: t?.messages ?? 0,
        calls: (t?.calls ?? 0) + 1,
        resent: (t?.resent ?? 0) + (u?.cache_read_input_tokens ?? 0),
        written: (t?.written ?? 0) + (u?.cache_creation_input_tokens ?? 0),
        fresh: (t?.fresh ?? 0) + (u?.input_tokens ?? 0),
        output: (t?.output ?? 0) + (u?.output_tokens ?? 0),
      }))
      await refresh($, options, false)
    }

    return res
  })

  // Ask before a switch that would throw away a large warm cache.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const at = typeof options.confirmModelSwitchAtTokens === 'number' ? options.confirmModelSwitchAtTokens : 100_000
    if (at > 0 && e.prompt_cache_warm && e.context_tokens >= at) {
      return {
        permissionDecision: 'ask' as const,
        permissionDecisionReason: `Switching to ${e.to_model} drops the warm cache: re-caching ${k(e.context_tokens)} costs about $${e.estimated_cache_write_usd.toFixed(2)}. Switch anyway?`,
      }
    }

    return next(e)
  })

  // Tell me when Claude is waiting on me.
  on('classic.Notification', async ($, e, next) => {
    if (options.notifyOnPermission !== false && /permission|elicitation/.test(e.notification_type)) {
      void $.ui.notify(e.message, { title: e.title ?? 'Claude Code' })
    }

    return next(e)
  })

  // A switch with /model is not a turn: re-read the model at once.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.cache_ttl === '1h' || e.cache_ttl === '5m') {
      await update($, seenTtl, () => e.cache_ttl)
      await $.store.set('cacheTtl', e.cache_ttl)
    }
    // A switch drops the warm cache: the next request writes the context again.
    if (e.prompt_cache_warm && e.context_tokens >= 50_000) {
      $.ui.toast(
        `Model switch: the warm cache is lost. Re-caching ${k(e.context_tokens)} costs about $${e.estimated_cache_write_usd.toFixed(2)}.`,
      )
    }
    await refresh($, options, true)

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck',
      description: 'Open the session deck pane (model, context, limits, branch, PRs, todos)',
    })
    await $.command.register({
      name: 'handoff',
      description: 'Write .claude/handoff.md (branch, changes, todos, PRs) for the next session',
    })
    await $.command.register({
      name: 'deck-stats',
      description: 'Summarize this session: messages, requests, tokens, cost, costliest message',
    })
    // Redraw now and then so the cache countdown moves between messages.
    $.clock.every(10_000, () => $.ui.invalidate('ui.render'))
    await refresh($, options, true)

    const remembered = await $.store.get('cacheTtl')
    if (remembered === '1h' || remembered === '5m') await update($, seenTtl, () => remembered)

    // The first time this mod ever loads, say what it is and how to tune it. Once.
    if (e.isInteractive && (await $.store.get('onboarded')) === undefined) {
      $.ui.log('session-deck is on: the deck above the prompt fills in after Claude\'s first reply. /deck opens the details, /handoff writes a note for the next session, /deck-stats sums the session. Tune it with /plugin configure session-deck@tailored.')
      await $.store.set('onboarded', true)
    }

    if (options.briefing !== false && e.isInteractive) {
      const d = await read($, deck)
      if (d !== null && d.branch !== null) {
        let hasHandoff = false
        try {
          await $.fs.read(`${d.dir}/.claude/handoff.md`)
          hasHandoff = true
        } catch {
          hasHandoff = false
        }
        $.ui.log(briefing(d, hasHandoff))
      }
    }

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const md = buildHandoff({
      now: new Date().toISOString().slice(0, 16).replace('T', ' '),
      dir: cwd,
      deck: await read($, deck),
      todo: await read($, todo),
      status: await git($, ['status', '--short']),
      log: await git($, ['log', '--oneline', '-5']),
      note: e.args.trim(),
    })
    const dir = `${cwd}/.claude`
    const file = `${dir}/handoff.md`
    try {
      await $.process.run(['mkdir', '-p', dir])
      await $.fs.write(file, md)
    } catch {
      return { text: `Could not write ${file}. Here is the note instead:\n\n${md}` }
    }

    return {
      text: [
        `Handoff note written to ${file}`,
        '',
        'Start the next session and paste:',
        'Read .claude/handoff.md and continue from there. First confirm the branch and the first unfinished todo.',
      ].join('\n'),
    }
  })

  on('command.run', { command: 'deck-stats' }, async $ => {
    const tot = await read($, totals)
    const top = await read($, peak)
    const d = await read($, deck)
    if (tot === null || tot.calls === 0) {
      return { text: 'Nothing counted yet. Stats count from when session-deck loaded.' }
    }
    const lines = [
      `${tot.messages} messages · ${tot.calls} model requests`,
      `${k(tot.resent)} re-read · ${k(tot.fresh + tot.written)} new · ${k(tot.output)} out`,
    ]
    if (d?.usd !== undefined) lines.push(`Session cost $${d.usd.toFixed(2)} (API-equivalent)`)
    if (top !== null) {
      lines.push(`Costliest message: $${top.usd.toFixed(2)} · ${top.calls} calls · ${k(top.resent)} re-read`)
    }
    if (d !== null) lines.push(`Context now ${d.percent}% (${k(d.tokens)}/${k(d.window)})`)

    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'deck' }, async $ => {
    const placed = await $.ui.open({ id: PANE, title: 'Session deck' })
    await refresh($, options, true)

    return {
      text: placed.isPlaced
        ? 'Session deck opened.'
        : 'No room for the pane here; the band above the prompt shows the essentials.',
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage !== undefined && calls === 0) {
      const u = e.usage
      const row: Spend = {
        calls: Math.max(1, calls),
        resent: u.cache_read_input_tokens,
        written: u.cache_creation_input_tokens,
        fresh: u.input_tokens,
        output: u.output_tokens,
      }
      await update($, spend, () => row)
    }
    await refresh($, options, false, true)

    if (e.agentId === undefined) {
      const d = await read($, deck)
      const row = await read($, spend)
      if (d?.turnUsd !== undefined && row !== null) {
        const usdNow = d.turnUsd
        await update($, peak, p =>
          p === null || usdNow > p.usd
            ? { usd: usdNow, calls: row.calls, resent: row.resent }
            : p,
        )
      }
      const after = typeof options.notifyAfterSeconds === 'number' ? options.notifyAfterSeconds : 60
      const took = (await $.clock.now()) - turnStartedAt
      if (after > 0 && turnStartedAt > 0 && took >= after * 1000) {
        const cost = d?.turnUsd !== undefined ? ` · +$${d.turnUsd.toFixed(2)}` : ''
        $.ui.toast(`Done in ${durationText(took)}${cost}`)
        void $.ui.notify(`Finished in ${durationText(took)}${cost}`, { title: 'Claude Code' })
      }
    }

    return next(e)
  })

  // Claude's todo list arrives through TodoWrite (the whole list at once) or,
  // in newer builds, TaskCreate / TaskUpdate (one change at a time).
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const items: TodoItem[] = e.todos.map((t, i) => ({
      id: String(i + 1),
      text: t.status === 'in_progress' ? t.activeForm : t.content,
      status: t.status,
    }))
    await update($, todo, () => ({ items }))
    await publish($, options)

    return next(e)
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.result?.task.id
    if (id !== undefined) {
      const item: TodoItem = { id, text: e.subject, status: 'pending' }
      await update($, todo, t => ({ items: [...(t?.items ?? []), item] }))
      await publish($, options)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    await update($, todo, t =>
      t === null
        ? t
        : {
            items: t.items.map(i =>
              i.id === e.taskId
                ? { ...i, text: e.subject ?? i.text, status: e.status ?? i.status }
                : i,
            ),
          },
    )
    await publish($, options)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const d = await read($, deck)
    if (!isBandOn(options) || e.props.hasSurvey || d === null) return next(e)

    const viewed = e.props.view?.agentId
    if (viewed !== undefined) {
      const all = await read($, agents)
      const mine = all[viewed]
      const { Box, Text } = $.ui.resolve(e)
      let label = 'subagent'
      try {
        const found = (await $.agent.list()).find(a => a.id === viewed)
        if (found?.description) label = found.description
      } catch {
        label = 'subagent'
      }
      if (mine === undefined) {
        return (
          <Box flexDirection="column">
            <Text dimColor>{'─'.repeat(Math.max(10, (e.props.bodyColumns ?? 80) - 1))}</Text>
            <Text>🧬 <Text bold color="magenta">{label}</Text><Text dimColor> · no request seen yet; the main figures are not this agent's</Text></Text>
          </Box>
        )
      }
      const pct = Math.min(100, Math.round((mine.tokens / d.window) * 100))

      return (
        <Box flexDirection="column">
          <Text dimColor>{'─'.repeat(Math.max(10, (e.props.bodyColumns ?? 80) - 1))}</Text>
          <Box>
            <Text>🧬 </Text>
            <Text bold color="magenta">{label}</Text>
            <Text dimColor>  {prettyModel(mine.model)} · this agent's own figures</Text>
          </Box>
          <Box>
            <Text>🧠 Context </Text>
            <Text bold color={tone(pct)}>{pct}%</Text>
            <Text color={tone(pct)}> [{bar(pct, 10)}]</Text>
            <Text dimColor> {k(mine.tokens)}/{k(d.window)}</Text>
          </Box>
          <Box>
            <Text>📨 {mine.calls} call{mine.calls === 1 ? '' : 's'}</Text>
            <Text dimColor> · </Text>
            <Text>{k(mine.resent)} re-read</Text>
            <Text dimColor> · </Text>
            <Text>{k(mine.fresh)} new</Text>
            <Text dimColor> · </Text>
            <Text>{k(mine.output)} out</Text>
          </Box>
        </Box>
      )
    }

    const t = progress(await read($, todo))
    const model = await $.session.model()
    const { Box, Text } = $.ui.resolve(e)
    const mine = d.prs?.find(p => p.branch === d.branch)
    const five = d.limits.find(l => l.kind === 'five_hour') ?? d.limits[0]
    const week = d.limits.find(l => l.kind === 'seven_day' && l !== five)
    const sp = await read($, spend)
    const last = await read($, lastAt)
    // The engine's own word (seen at a model switch) beats the option.
    const seen = await read($, seenTtl)
    // 1h unless the engine or the option says 5m: Claude Code sessions cache for an hour.
    const ttlMs = ((seen ?? options.cacheTtl ?? '1h') === '5m' ? 5 : 60) * 60_000
    const left = last === null ? null : ttlMs - (Date.now() - last)
    const compactAt = typeof options.compactHintPercent === 'number' ? options.compactHintPercent : 50
    const cachePrice = priceOf(model)?.cache
    const perCall = cachePrice !== undefined ? (d.tokens / 1_000_000) * cachePrice : null
    // Columns the first row already holds, so the path gets what is left.
    const leftLen =
      3 + prettyModel(model).length +
      (d.branch !== null ? 5 + d.branch.length + (d.worktree !== null ? 6 + d.worktree.length : 0) : 0) +
      (d.changes > 0 ? 2 + String(d.changes).length : 0) +
      (mine !== undefined ? 8 + String(mine.number).length : 0) +
      (d.prs !== null && d.prs.length > 0 ? 8 + String(d.prs.length).length : 0)

    return (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(Math.max(10, (e.props.bodyColumns ?? 80) - 1))}</Text>
        <Box>
          <Text>🤖 </Text>
          <Text bold color="magenta">{prettyModel(model)}</Text>
          {d.branch !== null && (
            <Text color="cyan">  🌿 {d.branch}{d.worktree !== null ? ` (wt ${d.worktree})` : ''}</Text>
          )}
          {d.changes > 0 && <Text color="yellow"> ±{d.changes}</Text>}
          {mine !== undefined && <Text color="blue">  🔀 PR#{mine.number}</Text>}
          {d.prs !== null && d.prs.length > 0 && <Text dimColor> ({d.prs.length} open)</Text>}
          {options.showDirectory !== false && (
            <Text dimColor>  📁 {tailPath(d.dir, Math.max(12, (e.props.bodyColumns ?? 80) - leftLen - 6))}</Text>
          )}
        </Box>
        <Box>
          <Text>🧠 Context </Text>
          <Text bold color={tone(d.percent)}>{d.percent}%</Text>
          <Text dimColor> used </Text>
          <Text color={tone(d.percent)}>[{bar(d.percent, 10)}]</Text>
          <Text dimColor> {k(d.tokens)}/{k(d.window)}</Text>
          {five !== undefined && (
            <Text>  ⏳ <Text color={tone(five.percent)}>{limitName(five.kind)} {five.percent}%</Text><Text dimColor>{resets(five.resetsAt)}</Text></Text>
          )}
          {week !== undefined && <Text color={tone(week.percent)}>  7d {week.percent}%</Text>}
        </Box>
        <Box>
          {d.usd !== undefined && (
            <Text>💰 <Text bold color="green">${d.usd.toFixed(2)}</Text>{d.turnUsd !== undefined ? <Text dimColor> (+${d.turnUsd.toFixed(2)})</Text> : ''}<Text dimColor> {priceText(model)}</Text></Text>
          )}
        </Box>
        <Box>
          {left !== null && (
            <Text>
              {left > 0 ? (
                <Text color={left > ttlMs * 0.4 ? 'green' : left > ttlMs * 0.15 ? 'yellow' : 'red'}>🧊 cache {clock(left)} left</Text>
              ) : (
                <Text color="red">🧊 cache expired: the next request re-caches {k(d.tokens)}</Text>
              )}
              {sp !== null || t !== null ? '  ' : ''}
            </Text>
          )}
          {sp !== null && (
            <Text>
              📨 {sp.calls} call{sp.calls === 1 ? '' : 's'}
              <Text dimColor> · </Text>
              {k(sp.resent)} re-read
              <Text dimColor> · </Text>
              {k(sp.fresh + sp.written)} new
              <Text dimColor> · </Text>
              {k(sp.output)} out
            </Text>
          )}
          {t !== null && t.total > 0 && (
            <Text>{sp !== null ? '  ' : ''}☑ <Text bold>{t.done}/{t.total}</Text>{t.current ? <Text dimColor> {t.current}</Text> : ''}</Text>
          )}
        </Box>
        {d.percent >= compactAt && (
          <Box>
            <Text color={tone(d.percent)}>
              💡 Context is large: each request re-reads {k(d.tokens)}
              {perCall !== null ? ` (~$${perCall.toFixed(2)})` : ''}. /compact or a new session makes the next ones cheaper.
            </Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const d = await read($, deck)
    if (d === null) {
      return <Text dimColor>No reading yet. It appears after Claude's first response.</Text>
    }
    const model = await $.session.model()
    const hist = await read($, history)
    const t = await read($, todo)
    const sum = progress(t)
    const tot = await read($, totals)
    const sp = await read($, spend)
    const fillRows = await read($, fill)
    const fillTotal = Math.max(1, (fillRows ?? []).reduce((n, r) => n + r.tokens, 0))
    const cols = Math.max(20, e.props.bodyColumns ?? 40)
    const width = Math.max(10, Math.min(MAX_HISTORY, cols - 2))
    const line = '─'.repeat(cols - 1)
    const price = priceText(model)
    const section = (icon: string, title: string, color: string) => (
      <Box flexDirection="column">
        <Text dimColor>{line}</Text>
        <Text bold color={color}>{icon} {title}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {section('🤖', 'Model', 'magenta')}
        <Text bold>{prettyModel(model)}</Text>
        {prettyModel(model) !== model && <Text dimColor>{model}</Text>}
        {price !== '' && <Text dimColor>{price}</Text>}

        {section('🧠', 'Context', tone(d.percent))}
        <Text>
          <Text bold color={tone(d.percent)}>{d.percent}%</Text>
          <Text color={tone(d.percent)}> [{bar(d.percent, 16)}]</Text>
        </Text>
        <Text dimColor>{k(d.tokens)} of {k(d.window)} tokens</Text>
        <Text color={tone(d.percent)}>{spark(hist.slice(-width))}</Text>
        {d.percent >= 50 && (
          <Text color={tone(d.percent)}>💡 /compact or a new session makes each request cheaper.</Text>
        )}

        {section('🧩', 'What fills the context', 'magenta')}
        {fillRows === null || fillRows.length === 0 ? (
          <Text dimColor>Measured after each message.</Text>
        ) : (
          fillRows.slice(0, 6).map(r => (
            <Text>
              <Text color="magenta">{bar(Math.round((r.tokens / fillTotal) * 100), 8)}</Text>
              {' '}{k(r.tokens)} <Text dimColor>{r.name}</Text>
            </Text>
          ))
        )}

        {section('⏳', 'Usage limits', 'yellow')}
        {d.limits.length === 0 && <Text dimColor>No limit reported (API key, or no response yet).</Text>}
        {d.limits.map(l => (
          <Text>
            <Text bold>{limitName(l.kind)} </Text>
            <Text color={tone(l.percent)}>[{bar(l.percent, 10)}] {l.percent}% used</Text>
            <Text dimColor> · {Math.round((100 - l.percent) * 10) / 10}% left{resets(l.resetsAt)}</Text>
          </Text>
        ))}

        {section('💰', 'Cost', 'green')}
        {d.usd === undefined ? (
          <Text dimColor>No cost ledger here.</Text>
        ) : (
          <Text>
            <Text bold color="green">${d.usd.toFixed(2)}</Text>
            <Text dimColor> API-equivalent, this session</Text>
            {d.turnUsd !== undefined && <Text> (this message +${d.turnUsd.toFixed(2)})</Text>}
          </Text>
        )}

        {section('📨', 'This message', 'blue')}
        {sp === null || sp.calls === 0 ? (
          <Text dimColor>Nothing counted yet.</Text>
        ) : (
          <Text>
            {sp.calls} call{sp.calls === 1 ? '' : 's'} · {k(sp.resent)} re-read · {k(sp.fresh + sp.written)} new · {k(sp.output)} out
          </Text>
        )}
        <Text dimColor>All of this session</Text>
        {tot === null || tot.calls === 0 ? (
          <Text dimColor>Counts from when the mod loaded.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              {tot.messages} messages · {tot.calls} requests · {k(tot.resent)} re-read · {k(tot.fresh + tot.written)} new · {k(tot.output)} out
            </Text>
            <Text dimColor>Re-read sums the context sent again on every request, so it dwarfs the {k(d.tokens)} the window holds now.</Text>
          </Box>
        )}

        {section('🌿', 'Git', 'cyan')}
        {d.branch === null ? (
          <Text dimColor>Not a git repository.</Text>
        ) : (
          <Text>
            <Text bold color="cyan">{d.branch}</Text>
            {d.worktree !== null && <Text> · worktree <Text bold>{d.worktree}</Text></Text>}
            {d.changes > 0 ? <Text color="yellow"> · {d.changes} changed</Text> : <Text color="green"> · clean</Text>}
          </Text>
        )}
        {options.showDirectory !== false && <Text dimColor>📁 {tailPath(d.dir, cols - 4)}</Text>}

        {section('🔀', 'Pull requests', 'blue')}
        {d.prs === null && <Text dimColor>{d.prsNote ?? 'Not loaded.'}</Text>}
        {d.prs !== null && d.prs.length === 0 && <Text dimColor>No open PRs.</Text>}
        {d.prs?.map(p => (
          <Text color={p.branch === d.branch ? 'cyan' : undefined} bold={p.branch === d.branch}>
            #{p.number} {p.isDraft ? '[draft] ' : ''}{p.title.slice(0, Math.max(10, cols - 24))}
            <Text dimColor> ({p.branch}){p.review ? ` · ${p.review.toLowerCase()}` : ''}</Text>
          </Text>
        ))}

        {section('☑', `Todos${sum !== null ? ` ${sum.done}/${sum.total}` : ''}`, 'yellow')}
        {sum === null && <Text dimColor>No todo list yet. Claude makes one for multi-step work.</Text>}
        {t?.items
          .filter(i => i.status !== 'deleted')
          .slice(-14)
          .map(i => (
            <Text
              bold={i.status === 'in_progress'}
              dimColor={i.status === 'completed'}
              color={i.status === 'in_progress' ? 'yellow' : undefined}
            >
              {i.status === 'completed' ? '✔' : i.status === 'in_progress' ? '▶' : '○'} {i.text.slice(0, Math.max(10, cols - 4))}
            </Text>
          ))}

        <Text dimColor>{line}</Text>
        <Button key="refresh" label="↻ Refresh" onPress={() => refresh($, options, true)} />
      </Box>
    )
  })
}
