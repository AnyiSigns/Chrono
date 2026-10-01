// 提供方 digest 契约：shell run 的成功结果自带 `{cmd, exit, stdout_tail}`，
// 形状是上下文老化可直接消费的普通对象；`stdout_tail` 有界（限行再限字符）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { invoke } from '../execute/invoke.ts'

const PROFILE = {
  command: { cmd: 'pwsh', argsPrefix: ['-NoProfile', '-Command'] },
  session: { cmd: 'pwsh', argsPrefix: ['-NoProfile', '-NoLogo', '-NoExit', '-Command', '-'] },
  sessionSyntax: 'powershell',
  python: 'python',
  label: 'pwsh',
  syntax: 'PowerShell',
}

const DONE = {
  output: '',
  next_cursor: 0,
  running: false,
  exit_code: 0,
  code: null,
  truncated: false,
  dropped_bytes: 0,
  tail: '',
}

function deps(pollResult) {
  return {
    profile: PROFILE,
    exec: {
      async start() {
        return { task_id: 'task-1' }
      },
      async poll() {
        return pollResult
      },
      async kill() {
        return { killed: true }
      },
      async sessionClose() {
        return { closed: true }
      },
    },
    secrets: {
      async resolve() {
        return 'secret'
      },
    },
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('shell run 结果带 digest {cmd,exit,stdout_tail}', async () => {
  const result = await invoke(
    { tool: 'shell', args: { input: 'echo hi' } },
    deps({ ...DONE, output: 'hi\n', next_cursor: 3 }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.result.stdout, 'hi\n')
  const digest = result.result.digest
  assert.ok(isPlainObject(digest), 'digest 必须是普通对象')
  assert.equal(digest.cmd, 'echo hi')
  assert.equal(digest.exit, 0)
  assert.equal(digest.stdout_tail, 'hi\n')
})

test('结果不重复 combined：stdout 是唯一输出源（stderr 已并入）', async () => {
  const result = await invoke(
    { tool: 'shell', args: { input: 'echo hi' } },
    deps({ ...DONE, output: 'hi\n', next_cursor: 3 }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.result.stdout, 'hi\n')
  assert.deepEqual(result.result.combined, [])
})

test('shell digest 的 stdout_tail 有界：仅保留最后 20 行', async () => {
  const lines = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`)
  const result = await invoke(
    { tool: 'shell', args: { input: 'emit-lines' } },
    deps({ ...DONE, output: lines.join('\n') }),
  )
  assert.equal(result.ok, true)
  const tail = result.result.digest.stdout_tail.split('\n')
  assert.equal(tail.length, 20)
  assert.equal(tail[0], 'line-6')
  assert.equal(tail[19], 'line-25')
})

test('background 结果带 digest，exit 为 null', async () => {
  const result = await invoke(
    { tool: 'shell', args: { input: 'npm run dev', background: true } },
    deps(DONE),
  )
  assert.equal(result.ok, true)
  const digest = result.result.digest
  assert.ok(isPlainObject(digest))
  assert.equal(digest.cmd, 'npm run dev')
  assert.equal(digest.exit, null)
  assert.equal(digest.stdout_tail, '')
})
