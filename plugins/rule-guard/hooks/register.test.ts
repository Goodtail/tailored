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

test('a Korean-only commit rule refuses an English subject', { options: { requireKoreanCommit: true } }, async ($, on) => {
  stub(on)
  const bad = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix login bug"' })
  expect(bad.deny).toContain('Korean')
  const good = await $.tool.call({ tool: 'Bash', command: 'git commit -m "로그인 오류 수정"' })
  expect(good.deny).toBeUndefined()
})

test('the commit subject pattern reads a heredoc too', { options: { commitSubjectPattern: '^\\[(기능|수정)\\] ' } }, async ($, on) => {
  stub(on)
  const heredoc = "git commit -m \"$(cat <<'EOF'\n[기능] 로그인 추가\n\n본문\nEOF\n)\""
  const ok = await $.tool.call({ tool: 'Bash', command: heredoc })
  expect(ok.deny).toBeUndefined()
  const bad = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: add login"' })
  expect(bad.deny).toContain('must match')
})

test('a subagent with no model gets the chosen one, an architect keeps its own', { options: { defaultSubagentModel: 'sonnet', subagentKeepModelFor: 'architect' } }, async ($, on) => {
  let seen: { model?: string } = {}
  on('session.cwd', () => ({ value: '/work/app' }))
  on('tool.call', (_, e) => {
    seen = e as { model?: string }
    return { result: {} }
  })
  await $.tool.call({ tool: 'Agent', description: 'do it', prompt: 'p', subagent_type: 'executor' })
  expect(seen.model).toBe('sonnet')
  await $.tool.call({ tool: 'Agent', description: 'design', prompt: 'p', subagent_type: 'oh-my-claudecode:architect' })
  expect(seen.model).toBeUndefined()
})

test('/guard-status lists the rules and what was refused', async ($, on) => {
  stub(on)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x\n\nCo-Authored-By: Claude <a@b.c>"' })
  const out = await $.command.run({ command: 'guard-status' })
  expect(out.text).toContain('AI attribution')
  expect(out.text).toContain('Refused 1 time')
})

test('a heredoc that writes another file is not read as the commit message', { options: { requireKoreanCommit: true } }, async ($, on) => {
  stub(on)
  const command = "cat > README.md <<'EOF'\n# readme title\nEOF\ngit commit -m \"[기능] 문서 추가\""
  const ran = await $.tool.call({ tool: 'Bash', command })
  expect(ran.deny).toBeUndefined()
})
