import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deck, Limit, Pr, Spend, Todo, TodoItem } from '../types'

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

const prettyModel = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (m === null) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

const spend = atom({ plugin: 'session-deck', key: 'spend' } as const, null, {
  shape: 'spend-1',
})

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

let lastRefresh = 0

async function refresh(
  $: EngineInterface,
  options: Readonly<Record<string, unknown>>,
  force: boolean,
  isTurnEnd = false,
) {
  // A turn with many steps refreshes after each; keep git and gh calm.
  if (!force && !isTurnEnd && Date.now() - lastRefresh < 1500) return
  lastRefresh = Date.now()
  const usage = await $.session.usage()
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
    turnUsd:
      usage.cost !== undefined && previous?.usd !== undefined && usage.cost.usd > previous.usd
        ? usage.cost.usd - previous.usd
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      calls = 0
      await update($, spend, () => ({ calls: 0, resent: 0, written: 0, fresh: 0, output: 0 }))
    }

    return next(e)
  })

  // After each model request: add its tokens to this message's spend, and
  // refresh the figures so the band moves while Claude is still working.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (e.agentId === undefined) {
      calls += 1
      const u = res.usage
      await update($, spend, row => ({
        calls,
        resent: (row?.resent ?? 0) + (u?.cache_read_input_tokens ?? 0),
        written: (row?.written ?? 0) + (u?.cache_creation_input_tokens ?? 0),
        fresh: (row?.fresh ?? 0) + (u?.input_tokens ?? 0),
        output: (row?.output ?? 0) + (u?.output_tokens ?? 0),
      }))
      await refresh($, options, false)
    }

    return res
  })

  // A switch with /model is not a turn: re-read the model at once.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await refresh($, options, true)

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck',
      description: 'Open the session deck pane (model, context, limits, branch, PRs, todos)',
    })
    await refresh($, options, true)

    return next(e)
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

    const t = progress(await read($, todo))
    const model = await $.session.model()
    const { Box, Text } = $.ui.resolve(e)
    const mine = d.prs?.find(p => p.branch === d.branch)
    const five = d.limits.find(l => l.kind === 'five_hour') ?? d.limits[0]
    const week = d.limits.find(l => l.kind === 'seven_day' && l !== five)
    const sp = await read($, spend)
    // Columns the first row already holds, so the path gets what is left.
    const leftLen =
      3 + prettyModel(model).length +
      (d.branch !== null ? 5 + d.branch.length + (d.worktree !== null ? 6 + d.worktree.length : 0) : 0) +
      (d.changes > 0 ? 2 + String(d.changes).length : 0) +
      (mine !== undefined ? 8 + String(mine.number).length : 0) +
      (d.prs !== null && d.prs.length > 0 ? 8 + String(d.prs.length).length : 0)

    return (
      <Box flexDirection="column">
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
            <Text>💰 <Text bold color="green">${d.usd.toFixed(2)}</Text>{d.turnUsd !== undefined ? <Text dimColor> (+${d.turnUsd.toFixed(2)})</Text> : ''}<Text dimColor> API-equivalent</Text></Text>
          )}
          {sp !== null && (
            <Text>
              {'  '}📨 {sp.calls} call{sp.calls === 1 ? '' : 's'}
              <Text dimColor> · </Text>
              {k(sp.resent)} re-read
              <Text dimColor> · </Text>
              {k(sp.fresh + sp.written)} new
              <Text dimColor> · </Text>
              {k(sp.output)} out
            </Text>
          )}
          {t !== null && t.total > 0 && (
            <Text>  ☑ <Text bold>{t.done}/{t.total}</Text>{t.current ? <Text dimColor> {t.current}</Text> : ''}</Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const d = await read($, deck)
    if (d === null) {
      return <Text dimColor>No reading yet. It appears after Claude's first response.</Text>
    }
    const hist = await read($, history)
    const t = await read($, todo)
    const sum = progress(t)
    const width = Math.max(10, Math.min(MAX_HISTORY, (e.viewport?.columns ?? 40) - 4))

    return (
      <Box flexDirection="column">
        <Text bold>Model</Text>
        <Text>{prettyModel(d.model)}{prettyModel(d.model) !== d.model ? ` (${d.model})` : ''}</Text>
        <Text> </Text>
        <Text bold>Context</Text>
        <Text color={tone(d.percent)}>{bar(d.percent, 20)} {d.percent}%</Text>
        <Text dimColor>{k(d.tokens)} of {k(d.window)} tokens</Text>
        <Text>{spark(hist.slice(-width))}</Text>
        <Text> </Text>
        <Text bold>Usage limits</Text>
        {d.limits.length === 0 && <Text dimColor>No limit reported (API key, or no response yet).</Text>}
        {d.limits.map(l => (
          <Text color={tone(l.percent)}>
            {limitName(l.kind)} {bar(l.percent, 10)} {l.percent}% used, {Math.round((100 - l.percent) * 10) / 10}% left{resets(l.resetsAt)}
          </Text>
        ))}
        {d.usd !== undefined && (
          <Text>
            API-equivalent cost ${d.usd.toFixed(2)}
            {d.turnUsd !== undefined ? ` (last turn +$${d.turnUsd.toFixed(2)})` : ''}
          </Text>
        )}
        <Text> </Text>
        <Text bold>Git</Text>
        {d.branch === null ? (
          <Text dimColor>Not a git repository.</Text>
        ) : (
          <Text>
            ⎇ {d.branch}
            {d.worktree !== null ? `  · worktree ${d.worktree}` : ''}
            {d.changes > 0 ? `  · ${d.changes} changed` : '  · clean'}
          </Text>
        )}
        {options.showDirectory === true && <Text dimColor>{d.dir}</Text>}
        <Text> </Text>
        <Text bold>Pull requests</Text>
        {d.prs === null && <Text dimColor>{d.prsNote ?? 'Not loaded.'}</Text>}
        {d.prs !== null && d.prs.length === 0 && <Text dimColor>No open PRs.</Text>}
        {d.prs?.map(p => (
          <Text color={p.branch === d.branch ? 'cyan' : undefined}>
            #{p.number} {p.isDraft ? '[draft] ' : ''}{p.title.slice(0, 48)} ({p.branch}){p.review ? ` · ${p.review.toLowerCase()}` : ''}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Todos{sum !== null ? ` (${sum.done}/${sum.total})` : ''}</Text>
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
              {i.status === 'completed' ? '✔' : i.status === 'in_progress' ? '▶' : '○'} {i.text.slice(0, 60)}
            </Text>
          ))}
        <Text> </Text>
        <Button key="refresh" label="Refresh" onPress={() => refresh($, options, true)} />
      </Box>
    )
  })
}
