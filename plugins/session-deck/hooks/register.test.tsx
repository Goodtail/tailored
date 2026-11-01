import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-deck',
  component: 'Pane',
  requestId: 'session-deck',
  props: {
    title: 'Session deck',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function stubEngine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'opus-test' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 84000, window: 200000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
      cost: { usd: 1.5 },
    },
  }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    const out = argv.includes('--abbrev-ref')
      ? 'feature/x'
      : argv.includes('--show-toplevel')
        ? '/work/app-wt'
        : argv.includes('--absolute-git-dir')
          ? '/work/app/.git/worktrees/app-wt'
          : argv.includes('--git-common-dir')
            ? '/work/app/.git'
            : argv.startsWith('git status')
              ? ' M a.ts\n?? b.ts'
              : argv.startsWith('gh')
                ? '[{"number":7,"title":"Add deck","headRefName":"feature/x","isDraft":false,"reviewDecision":"APPROVED"}]'
                : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
}

test('the pane shows model, context, limit, worktree branch and PR', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
  expect(await text(/opus-test/)).toBe('opus-test')
  expect(await text(/42%/)).toContain('42%')
  expect(await text(/5h/)).toContain('23.5% used')
  expect(await text(/feature\/x/)).toContain('worktree app-wt')
  expect(await text(/#7/)).toContain('Add deck')
  await ui.unmount()
})

test('the band draws three labeled rows above the prompt', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'session-deck',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 } },
  })
  expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toContain('Context')
  expect((await ui.find({ type: 'Text', text: /feature\/x/ }))?.text).toContain('wt app-wt')
  await ui.unmount()
})

test('before any response the pane says so', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/No reading yet/)
  await ui.unmount()
})

test('the pane lists the todos Claude wrote', async ($, on) => {
  stubEngine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
      { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
      { content: 'Celebrate', status: 'pending', activeForm: 'Celebrating' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Todos/ }))?.text).toBe('☑ Todos 1/3')
  expect((await ui.find({ type: 'Text', text: /Shipping it/ }))?.text).toContain('▶')
  expect((await ui.find({ type: 'Text', text: /Write tests/ }))?.text).toContain('✔')
  await ui.unmount()
})

test('a model switch that would drop a big warm cache asks first', async ($, on) => {
  stubEngine(on)
  const ask = await $.classic.PreModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: 300000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 1.5,
    pricing: 'catalog',
  })
  expect(ask.permissionDecision).toBe('ask')
  expect(ask.permissionDecisionReason).toContain('$1.50')
})

test('/handoff writes the note and says what to paste', async ($, on) => {
  stubEngine(on)
  let written = ''
  on('fs.write', (_, e) => {
    written = e.text
    return { value: undefined }
  })
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'handoff', args: 'next: wire the button' })
  expect(out.text).toContain('handoff.md')
  expect(written).toContain('next: wire the button')
  expect(written).toContain('feature/x')
})

test('in a subagent view the band is about that agent, not the main conversation', async ($, on) => {
  stubEngine(on)
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Scan the repo' }] }))
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'session-deck',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: { agentId: 'a1' },
    },
  })
  expect((await ui.find({ type: 'Text', text: /Scan the repo/ }))?.text).toContain('Scan the repo')
  await ui.unmount()
})
