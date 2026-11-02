import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileAct, Helper } from '../types'

const PANE = 'agent-watch'
const MAX_FILES_KEPT = 200
const MAX_HELPERS_KEPT = 40
const HIDE_DONE_AFTER_MS = 5 * 60_000

// Change a tag when a shape changes: it declines what an earlier version
// stored, which outlives a reload.
const helpers = atom({ plugin: 'agent-watch', key: 'helpers' } as const, {}, { shape: 'helpers-1' })
const files = atom({ plugin: 'agent-watch', key: 'files' } as const, {}, { shape: 'files-1' })

// API list prices, US dollars per million tokens (as of 2026-10). `cache` is the
// cache-read price where it is published. A model not listed gets no estimate.
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

// An estimate, not a bill: a cache read costs the published price (a tenth of the
// input price where none is published) and a cache write 1.25 times the input price.
function estimate(h: Helper): number | null {
  const price = PRICES.find(r => r.match.test(h.model))
  if (price === undefined) return null
  const read = price.cache ?? price.in * 0.1
  const cost = h.fresh * price.in + h.written * price.in * 1.25 + h.resent * read + h.output * price.out

  return cost / 1_000_000
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))
const money = (n: number | null) => (n === null ? '≈$?' : `≈$${n < 0.01 && n > 0 ? '<0.01' : n.toFixed(2)}`)
const clip = (t: string, n: number) => (t.length <= n ? t : `…${t.slice(t.length - (n - 1))}`)
const lines = (t: string) => (t === '' ? 0 : t.split('\n').length)
const prettyModel = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (m === null) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}
const span = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const cells = (t: string) => t.length + (t.match(/\p{Extended_Pictographic}/gu)?.length ?? 0)
const bar = (done: number, total: number, width: number) => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// Who a tool call belongs to: a helper's label, or "main".
function whoIs(all: Record<string, Helper>, agentId: string | undefined): string {
  if (agentId === undefined) return 'main'
  return all[agentId]?.label ?? agentId.slice(0, 6)
}

function touched(
  all: Record<string, FileAct>,
  path: string,
  kind: 'read' | 'edit',
  plus: number,
  minus: number,
  who: string,
): Record<string, FileAct> {
  const before = all[path]
  const by = [...(before?.by ?? []).filter(w => w !== who), who].slice(-4)
  const next: FileAct = {
    reads: (before?.reads ?? 0) + (kind === 'read' ? 1 : 0),
    edits: (before?.edits ?? 0) + (kind === 'edit' ? 1 : 0),
    plus: (before?.plus ?? 0) + plus,
    minus: (before?.minus ?? 0) + minus,
    by,
    last: Date.now(),
  }
  const merged = { ...all, [path]: next }
  const keys = Object.keys(merged)
  if (keys.length <= MAX_FILES_KEPT) return merged
  const keep = keys.sort((a, b) => merged[b].last - merged[a].last).slice(0, MAX_FILES_KEPT)
  const out: Record<string, FileAct> = {}
  for (const key of keep) out[key] = merged[key]

  return out
}

async function record(
  $: EngineInterface,
  agentId: string | undefined,
  path: string,
  kind: 'read' | 'edit',
  plus: number,
  minus: number,
) {
  const who = whoIs(await read($, helpers), agentId)
  await update($, files, all => touched(all, path, kind, plus, minus, who))
}

async function labelFor($: EngineInterface, id: string): Promise<string> {
  try {
    const found = (await $.agent.list()).find(a => a.id === id)
    if (found?.description) return found.description
  } catch {
    // fall through
  }

  return id.slice(0, 6)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents',
      description: 'Open the agent watch pane (helpers, their cost, and the files touched). /agents clear resets it.',
    })

    return next(e)
  })

  on('command.run', { command: 'agents' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, helpers, () => ({}))
      await update($, files, () => ({}))

      return { text: 'Agent watch cleared.' }
    }
    const placed = await $.ui.open({ id: PANE, title: 'Agent watch' })
    const all = Object.values(await read($, helpers))
    const total = all.reduce((n, h) => n + (estimate(h) ?? 0), 0)

    return {
      text: placed.isPlaced
        ? `Agent watch opened: ${all.length} helper${all.length === 1 ? '' : 's'}, ${money(total)} so far.`
        : `No room for the pane here. ${all.length} helper${all.length === 1 ? '' : 's'}, ${money(total)} so far.`,
    }
  })

  // What a helper has used, request by request. The main conversation is not
  // counted here: its numbers are in the session's own cost.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (e.agentId !== undefined && res.usage !== null) {
      const id = e.agentId
      const u = res.usage
      const known = (await read($, helpers))[id]
      const label = known?.label ?? (await labelFor($, id))
      await update($, helpers, all => {
        const before = all[id]
        const row: Helper = {
          label,
          model: u.model,
          status: 'running',
          startedAt: before?.startedAt ?? Date.now(),
          calls: (before?.calls ?? 0) + 1,
          resent: (before?.resent ?? 0) + u.cache_read_input_tokens,
          written: (before?.written ?? 0) + u.cache_creation_input_tokens,
          fresh: (before?.fresh ?? 0) + u.input_tokens,
          output: (before?.output ?? 0) + u.output_tokens,
        }
        const others = Object.keys(all).filter(x => x !== id).slice(-(MAX_HELPERS_KEPT - 1))
        const kept: Record<string, Helper> = {}
        for (const key of others) kept[key] = all[key]
        kept[id] = row

        return kept
      })
    }

    return res
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const all = await read($, helpers)
      const h = all[id]
      if (h !== undefined) {
        await update($, helpers, cur => (cur[id] ? { ...cur, [id]: { ...cur[id], status: 'done' as const, endedAt: Date.now() } } : cur))
        if (options.toastWhenHelperFinishes !== false) {
          const mine = Object.entries(await read($, files)).filter(([, f]) => f.edits > 0 && f.by.includes(h.label)).length
          $.ui.toast(`Helper "${clip(h.label, 30)}" done · ${money(estimate(h))}${mine > 0 ? ` · ${mine} file${mine === 1 ? '' : 's'} changed` : ''}`)
        }
      }
    }

    return next(e)
  })

  // Who read and who changed which file.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await record($, e.agentId, e.file_path, 'read', 0, 0)

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await record($, e.agentId, e.file_path, 'edit', lines(e.new_string), lines(e.old_string))
    }

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await record($, e.agentId, e.file_path, 'edit', lines(e.content), 0)

    return ran
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await record($, e.agentId, e.notebook_path, 'edit', lines(e.new_source), 0)
    }

    return ran
  })

  // One line above the prompt while helpers are around.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.showProgressLine === false || e.props.hasSurvey || e.props.view?.agentId !== undefined) return next(e)
    const all = Object.values(await read($, helpers))
    if (all.length === 0) return next(e)
    const running = all.filter(h => h.status === 'running').length
    const latest = Math.max(...all.map(h => h.endedAt ?? Date.now()))
    if (running === 0 && Date.now() - latest > HIDE_DONE_AFTER_MS) return next(e)

    const { Text } = $.ui.resolve(e)
    const done = all.length - running
    const total = all.reduce((n, h) => n + (estimate(h) ?? 0), 0)
    const changed = Object.values(await read($, files)).filter(f => f.edits > 0).length
    const cols = Math.max(24, e.props.bodyColumns ?? 80)
    const barText = cols >= 70 ? ` [${bar(done, all.length, 8)}]` : ''

    return (
      <Text wrap="truncate-end">
        🧬 <Text bold color="magenta">{done}/{all.length}</Text> helpers{barText}
        {running > 0 ? <Text color="yellow"> · {running} running</Text> : ''}
        <Text> · {money(total)}</Text>
        {changed > 0 ? <Text color="yellow"> · ✎ {changed} file{changed === 1 ? '' : 's'}</Text> : ''}
        <Text dimColor> · /agents</Text>
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = Object.entries(await read($, helpers)).sort((a, b) => b[1].startedAt - a[1].startedAt)
    const fileRows = Object.entries(await read($, files)).sort((a, b) => b[1].last - a[1].last)
    const cwd = await $.session.cwd()
    const cols = Math.max(24, e.props.bodyColumns ?? 40)
    const rule = '─'.repeat(cols - 1)
    const max = typeof options.maxFiles === 'number' && options.maxFiles > 0 ? options.maxFiles : 40
    const total = all.reduce((n, [, h]) => n + (estimate(h) ?? 0), 0)
    const changed = fileRows.filter(([, f]) => f.edits > 0)
    const rel = (p: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p.replace(/^\/(Users|home)\/[^/]+/, '~'))

    return (
      <Box flexDirection="column">
        <Text dimColor>{rule}</Text>
        <Text bold color="magenta">🧬 Helpers</Text>
        {all.length === 0 && <Text dimColor>No helper has run yet. Subagents Claude starts show up here.</Text>}
        {all.map(([id, h]) => (
          <Text wrap="truncate-end">
            <Text color={h.status === 'running' ? 'yellow' : 'green'}>{h.status === 'running' ? '●' : '✔'}</Text>
            {' '}<Text bold>{clip(h.label, Math.max(12, Math.floor(cols / 3)))}</Text>
            <Text dimColor> {prettyModel(h.model)} · {h.calls}× · {k(h.resent)} re-read · {k(h.fresh + h.written)} new · {k(h.output)} out · {span((h.endedAt ?? Date.now()) - h.startedAt)} · </Text>
            <Text color="green">{money(estimate(h))}</Text>
          </Text>
        ))}
        {all.length > 0 && (
          <Text>
            <Text bold>{all.length} helper{all.length === 1 ? '' : 's'}</Text>
            <Text> · </Text>
            <Text bold color="green">{money(total)}</Text>
            <Text dimColor> estimated (cache writes counted at 1.25× input)</Text>
          </Text>
        )}

        <Text dimColor>{rule}</Text>
        <Text bold>🗂 Files <Text color="magenta">👁 read</Text> <Text color="yellow">✎ changed</Text> <Text dimColor>· {changed.length} changed of {fileRows.length} touched</Text></Text>
        {fileRows.length === 0 && <Text dimColor>No file has been read or changed yet.</Text>}
        {fileRows.slice(0, max).map(([path, f]) => {
          const isChanged = f.edits > 0
          const who = f.by.join(', ')
          const stat = isChanged ? ` +${f.plus} −${f.minus}` : ''
          const room = Math.max(10, cols - cells(` ${stat} (${who})`) - 6)

          return (
            <Text wrap="truncate-end" color={isChanged ? 'yellow' : 'magenta'}>
              {isChanged ? '✎' : '👁'} <Text bold={isChanged}>{clip(rel(path), room)}</Text>
              <Text dimColor>{stat} ({who})</Text>
            </Text>
          )
        })}
        {fileRows.length > max && <Text dimColor>… and {fileRows.length - max} more</Text>}
        <Text dimColor>Counts Read, Edit, Write and NotebookEdit calls. Files changed through Bash are not seen.</Text>
        <Text dimColor>{rule}</Text>
        <Button key="clear" label="Clear" onPress={() => { void update($, helpers, () => ({})); void update($, files, () => ({})) }} />
      </Box>
    )
  })
}
