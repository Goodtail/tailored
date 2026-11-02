import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-watch',
  component: 'Pane',
  requestId: 'agent-watch',
  props: {
    title: 'Agent watch',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function stub(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('session.cwd', () => ({ value: '/work/app' }))
  on('command.register', () => ({ value: { command: 'agents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))
}

test('the pane marks what was changed and what was only read', async ($, on) => {
  stub(on)
  await $.tool.call({ tool: 'Read', file_path: '/work/app/README.md' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/work/app/src/a.ts',
    old_string: 'one',
    new_string: 'one\ntwo\nthree',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const changed = await ui.find({ type: 'Text', text: /src\/a\.ts/ })
  expect(changed?.text).toContain('✎')
  expect(changed?.text).toContain('+3 −1')
  const read = await ui.find({ type: 'Text', text: /README\.md/ })
  expect(read?.text).toContain('👁')
  await ui.unmount()
})

test('with no helper the pane says so', async ($, on) => {
  stub(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No helper has run yet/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('/agents clear forgets the files', async ($, on) => {
  stub(on)
  await $.tool.call({ tool: 'Read', file_path: '/work/app/a.txt' })
  const out = await $.command.run({ command: 'agents', args: 'clear' })
  expect(out.text).toContain('cleared')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /a\.txt/ })).toBeUndefined()
  await ui.unmount()
})
