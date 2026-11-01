import { expect, test } from 'claude-code/testing'

function stub(on: Parameters<Parameters<typeof test>[1]>[1], cwd = '/work/app') {
  on('session.cwd', () => ({ value: cwd }))
  on('tool.call', () => ({ result: {} }))
}

test('a commit with a Co-Authored-By: Claude trailer is refused', async ($, on) => {
  stub(on)
  const ran = await $.tool.call({
    tool: 'Bash',
    command: 'git commit -m "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
  })
  expect(ran.deny).toContain('AI attribution')
})

test('a clean commit and unrelated text go through', async ($, on) => {
  stub(on)
  const ok = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: bug"' })
  expect(ok.deny).toBeUndefined()
  const echo = await $.tool.call({ tool: 'Bash', command: 'echo "Co-Authored-By: Claude"' })
  expect(echo.deny).toBeUndefined()
})

test('the attribution guard can be turned off', { options: { blockAiAttribution: false } }, async ($, on) => {
  stub(on)
  const ran = await $.tool.call({
    tool: 'Bash',
    command: 'git commit -m "x\n\nCo-Authored-By: Claude <a@b.c>"',
  })
  expect(ran.deny).toBeUndefined()
})

test('a destructive command with nobody to ask is refused', async ($, on) => {
  stub(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~3' })
  expect(ran.deny).toContain('git reset --hard')
})

test('the custom pattern blocks inside its folders only', { options: { customDenyPattern: '9VP73Q9QX3', customDenyScope: '/company/', customDenyMessage: 'Wrong Apple team.' } }, async ($, on) => {
  stub(on, '/work/company/app')
  const hit = await $.tool.call({ tool: 'Bash', command: 'xcodebuild DEVELOPMENT_TEAM=9VP73Q9QX3' })
  expect(hit.deny).toContain('Wrong Apple team.')
})

test('the custom pattern is ignored outside its folders', { options: { customDenyPattern: '9VP73Q9QX3', customDenyScope: '/company/' } }, async ($, on) => {
  stub(on, '/work/personal/app')
  const ran = await $.tool.call({ tool: 'Bash', command: 'xcodebuild DEVELOPMENT_TEAM=9VP73Q9QX3' })
  expect(ran.deny).toBeUndefined()
})
