// `tool-shell` invoke 单元测试：run（默认会话 / 一次性 code）/ background / output / kill / reset、
// 平台 shell、workdir / timeout_ms / description / fresh、流式 `tool.delta`、密钥注入、错误码映射与白名单。
// 反向调用抽成可注入接口（ExecBackend / SecretsBackend），用假后端捕获入参。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { invoke } from '../execute/invoke.ts'
import { DEFAULT_CAPS } from '../execute/describe.ts'
import { ToolError } from '../execute/types.ts'

const PROFILE = {
  command: { cmd: 'pwsh', argsPrefix: ['-NoProfile', '-Command'] },
  session: { cmd: 'pwsh', argsPrefix: ['-NoProfile', '-NoLogo', '-NoExit', '-Command', '-'] },
  sessionSyntax: 'powershell',
  python: 'python',
  label: 'pwsh',
  syntax: 'PowerShell',
}

const POSIX = {
  command: { cmd: 'bash', argsPrefix: ['-c'] },
  session: { cmd: 'bash', argsPrefix: ['-s'] },
  sessionSyntax: 'posix',
  python: 'python3',
  label: 'bash',
  syntax: 'POSIX shell',
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

function fakeDeps(options = {}) {
  const startCalls = []
  const pollCalls = []
  const killCalls = []
  const closeCalls = []
  const secretCalls = []
  const emitted = []
  const deps = {
    profile: options.profile ?? PROFILE,
    emit:
      options.noEmit === true ? undefined : (topic, payload) => emitted.push({ topic, payload }),
    exec: {
      async start(args) {
        startCalls.push(args)
        if (options.startError) throw options.startError
        return options.startResult ?? { task_id: 'task-1' }
      },
      async poll(args) {
        pollCalls.push(args)
        return options.pollResult ?? DONE
      },
      async kill(args) {
        killCalls.push(args)
        return { killed: true }
      },
      async sessionClose(args) {
        closeCalls.push(args)
        return { closed: true }
      },
    },
    secrets: {
      async resolve(authRef) {
        secretCalls.push(authRef)
        if (options.secretError) throw options.secretError
        return options.secretValue ?? 'secret-value'
      },
    },
  }
  return { deps, startCalls, pollCalls, killCalls, closeCalls, secretCalls, emitted }
}

function bag(overrides = {}) {
  return {
    tool: 'shell',
    args: { input: 'echo hi' },
    tier: 'severe',
    workspace_root: 'C:\\ws',
    caps: { fs: { read: 'workspace', write: 'workspace' }, net: 'none' },
    grant: { call_id: 'g1' },
    sandbox_tiers: { version: 1 },
    ...overrides,
  }
}

test('command 模式默认走常驻会话：exec_start 收到 session bag，轮询到结束回 terminal 结果', async () => {
  const { deps, startCalls, pollCalls } = fakeDeps({
    pollResult: { ...DONE, output: 'hi\n', next_cursor: 3 },
  })
  const result = await invoke(bag(), deps, 'thread-1')
  assert.equal(result.ok, true)
  assert.equal(result.result.kind, 'terminal')
  assert.equal(result.result.stdout, 'hi\n')
  assert.equal(startCalls.length, 1)
  assert.equal(startCalls[0].session_id, 'thread-1')
  assert.equal(startCalls[0].command, 'echo hi')
  assert.deepEqual(startCalls[0].session_shell, {
    cmd: 'pwsh',
    args: ['-NoProfile', '-NoLogo', '-NoExit', '-Command', '-'],
    syntax: 'powershell',
  })
  assert.equal(startCalls[0].tier, 'severe')
  assert.equal(startCalls[0].workspace_root, 'C:\\ws')
  assert.deepEqual(startCalls[0].grant, { call_id: 'g1' })
  assert.equal(startCalls[0].cmd, undefined)
  assert.equal(pollCalls.length, 1)
  assert.equal(pollCalls[0].task_id, 'task-1')
})

test('会话键缺省 default（未传 sessionId）', async () => {
  const { deps, startCalls } = fakeDeps()
  await invoke({ tool: 'shell', args: { input: 'pwd' } }, deps)
  assert.equal(startCalls[0].session_id, 'default')
})

test('平台原生 shell：unix profile 的会话口径 bash -s', async () => {
  const { deps, startCalls } = fakeDeps({ profile: POSIX })
  await invoke({ tool: 'shell', args: { input: 'echo hi' } }, deps)
  assert.deepEqual(startCalls[0].session_shell, { cmd: 'bash', args: ['-s'], syntax: 'posix' })
  assert.equal(startCalls[0].command, 'echo hi')
})

test('code javascript / python 走一次性进程；code shell 走会话', async () => {
  const js = fakeDeps()
  await invoke(
    { tool: 'shell', args: { mode: 'code', language: 'javascript', input: 'console.log(1)' } },
    js.deps,
  )
  assert.equal(js.startCalls[0].cmd, 'node')
  assert.deepEqual(js.startCalls[0].args, ['-e', 'console.log(1)'])
  assert.equal(js.startCalls[0].session_id, undefined)

  const py = fakeDeps()
  await invoke(
    { tool: 'shell', args: { mode: 'code', language: 'python', input: 'print(1)' } },
    py.deps,
  )
  assert.equal(py.startCalls[0].cmd, 'python')
  assert.deepEqual(py.startCalls[0].args, ['-c', 'print(1)'])

  const shell = fakeDeps()
  await invoke(
    { tool: 'shell', args: { mode: 'code', language: 'shell', input: 'echo 1' } },
    shell.deps,
  )
  assert.equal(shell.startCalls[0].command, 'echo 1')
  assert.equal(shell.startCalls[0].session_id, 'default')
})

test('code 模式：stdout 是 JSON 时解析进 result.value', async () => {
  const { deps } = fakeDeps({ pollResult: { ...DONE, output: '{"a":1}\n', next_cursor: 8 } })
  const result = await invoke(
    { tool: 'shell', args: { mode: 'code', language: 'javascript', input: 'x' } },
    deps,
  )
  assert.deepEqual(result.result.value, { a: 1 })
})

test('白名单外语言 / 缺 language → code_unsupported_language，且不执行', async () => {
  for (const args of [
    { mode: 'code', language: 'ruby', input: 'x' },
    { mode: 'code', input: 'x' },
  ]) {
    const { deps, startCalls } = fakeDeps()
    const result = await invoke({ tool: 'shell', args }, deps)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'code_unsupported_language')
    assert.equal(startCalls.length, 0)
  }
})

// ── 流式输出 ────────────────────────────────────────────────────────────────

test('前台执行把新输出经 tool.delta 实时下发（带 run / thread / call_id）', async () => {
  const { deps, emitted } = fakeDeps({
    pollResult: { ...DONE, output: 'line\n', next_cursor: 5 },
  })
  await invoke(
    bag({ run: 'r1', thread: 't1', call_id: 'call-9', args: { input: 'echo line' } }),
    deps,
  )
  assert.deepEqual(emitted, [
    {
      topic: 'tool.delta',
      payload: { call_id: 'call-9', run: 'r1', thread: 't1', delta: 'line\n' },
    },
  ])
})

test('缺 call_id / 无 emit 时不发 tool.delta', async () => {
  const noCall = fakeDeps({ pollResult: { ...DONE, output: 'x', next_cursor: 1 } })
  await invoke(bag({ args: { input: 'echo x' } }), noCall.deps)
  assert.equal(noCall.emitted.length, 0)

  const noEmit = fakeDeps({ pollResult: { ...DONE, output: 'x', next_cursor: 1 }, noEmit: true })
  await invoke(bag({ call_id: 'c1', args: { input: 'echo x' } }), noEmit.deps)
  assert.equal(noEmit.emitted.length, 0)
})

// ── workdir / timeout_ms / description / fresh ─────────────────────────────

test('workdir：相对路径以 workspace_root 为基准；绝对路径原样', async () => {
  const root = process.cwd()
  const relative = fakeDeps()
  await invoke(bag({ workspace_root: root, args: { input: 'pwd', workdir: 'sub' } }), relative.deps)
  assert.equal(relative.startCalls[0].cwd, path.resolve(root, 'sub'))

  const absolute = fakeDeps()
  await invoke(bag({ workspace_root: root, args: { input: 'pwd', workdir: root } }), absolute.deps)
  assert.equal(absolute.startCalls[0].cwd, root)
})

test('workdir 相对路径缺 workspace_root → bad_args，且不执行', async () => {
  const { deps, startCalls } = fakeDeps()
  const result = await invoke({ tool: 'shell', args: { input: 'pwd', workdir: 'sub' } }, deps)
  assert.equal(result.error.code, 'bad_args')
  assert.equal(startCalls.length, 0)
})

test('timeout_ms：只收紧不抬高（min 请求与声明上限）', async () => {
  const tight = fakeDeps()
  await invoke(
    bag({ caps: { ...DEFAULT_CAPS, timeout_ms: 60000 }, args: { input: 'x', timeout_ms: 10000 } }),
    tight.deps,
  )
  assert.equal(tight.startCalls[0].caps.timeout_ms, 10000)

  const over = fakeDeps()
  await invoke(
    bag({ caps: { ...DEFAULT_CAPS, timeout_ms: 60000 }, args: { input: 'x', timeout_ms: 999999 } }),
    over.deps,
  )
  assert.equal(over.startCalls[0].caps.timeout_ms, 60000)
})

test('description 只作展示 / 审批，不进 exec_start args', async () => {
  const { deps, startCalls } = fakeDeps()
  const result = await invoke(bag({ args: { input: 'echo hi', description: 'say hi' } }), deps)
  assert.equal(result.ok, true)
  assert.equal(startCalls[0].description, undefined)
})

test('fresh：先关会话再执行', async () => {
  const { deps, startCalls, closeCalls } = fakeDeps()
  await invoke(bag({ args: { input: 'echo hi', fresh: true } }), deps, 't9')
  assert.deepEqual(closeCalls, [{ session_id: 't9' }])
  assert.equal(startCalls[0].session_id, 't9')
})

// ── 后台任务 ────────────────────────────────────────────────────────────────

test('background：一次性 exec_start 起任务，立即回任务号；默认不套超时', async () => {
  const { deps, startCalls } = fakeDeps({ startResult: { task_id: 'task-9' } })
  const result = await invoke(
    bag({ args: { input: 'npm run dev', background: true, description: 'serve' } }),
    deps,
  )
  assert.equal(result.ok, true)
  assert.equal(result.result.background, true)
  assert.equal(result.result.task_id, 'task-9')
  assert.equal(startCalls[0].cmd, 'pwsh')
  assert.deepEqual(startCalls[0].args, ['-NoProfile', '-Command', 'npm run dev'])
  assert.equal(startCalls[0].caps.timeout_ms, 0)
  assert.equal(startCalls[0].session_id, undefined)
})

test('background + timeout_ms：按请求收紧', async () => {
  const { deps, startCalls } = fakeDeps()
  await invoke(bag({ args: { input: 'sleep 1', background: true, timeout_ms: 5000 } }), deps)
  assert.equal(startCalls[0].caps.timeout_ms, 5000)
})

test('action=output：轮询任务，回增量输出与状态', async () => {
  const { deps, pollCalls } = fakeDeps({
    pollResult: {
      output: 'line\n',
      next_cursor: 5,
      running: true,
      exit_code: null,
      code: null,
      truncated: false,
      dropped_bytes: 0,
      tail: '',
    },
  })
  const result = await invoke(
    { tool: 'shell', args: { action: 'output', task_id: 'task-9', cursor: 3, wait_ms: 100 } },
    deps,
  )
  assert.deepEqual(pollCalls, [{ task_id: 'task-9', cursor: 3, wait_ms: 100 }])
  assert.equal(result.result.stdout, 'line\n')
  assert.equal(result.result.next_cursor, 5)
  assert.equal(result.result.running, true)
  assert.equal(result.result.task_id, 'task-9')
})

test('action=kill：终止任务', async () => {
  const { deps, killCalls } = fakeDeps()
  const result = await invoke({ tool: 'shell', args: { action: 'kill', task_id: 'task-9' } }, deps)
  assert.deepEqual(killCalls, [{ task_id: 'task-9' }])
  assert.equal(result.result.killed, true)
})

test('action=reset：关当前会话', async () => {
  const { deps, closeCalls } = fakeDeps()
  const result = await invoke({ tool: 'shell', args: { action: 'reset' } }, deps, 't7')
  assert.deepEqual(closeCalls, [{ session_id: 't7' }])
  assert.equal(result.result.reset, true)
})

test('action=output / kill 缺 task_id → bad_args；未知 action → bad_args', async () => {
  const { deps, pollCalls, killCalls } = fakeDeps()
  assert.equal(
    (await invoke({ tool: 'shell', args: { action: 'output' } }, deps)).error.code,
    'bad_args',
  )
  assert.equal(
    (await invoke({ tool: 'shell', args: { action: 'kill' } }, deps)).error.code,
    'bad_args',
  )
  assert.equal(
    (await invoke({ tool: 'shell', args: { action: 'nope' } }, deps)).error.code,
    'bad_args',
  )
  assert.equal(pollCalls.length, 0)
  assert.equal(killCalls.length, 0)
})

// ── 结果面 ──────────────────────────────────────────────────────────────────

test('非零退出 → nonzero_exit，结果仍回带 exit_code', async () => {
  const { deps } = fakeDeps({ pollResult: { ...DONE, exit_code: 3, output: 'boom' } })
  const result = await invoke(bag(), deps)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'nonzero_exit')
  assert.equal(result.result.exit_code, 3)
})

test('资源超限被杀（code=timeout）→ 原码透传，结果仍回', async () => {
  const { deps } = fakeDeps({ pollResult: { ...DONE, exit_code: null, code: 'timeout' } })
  const result = await invoke(bag(), deps)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'timeout')
  assert.equal(result.result.exit_code, null)
})

test('输出截断：头部 + 省略标记 + 尾部', async () => {
  const { deps } = fakeDeps({
    pollResult: { ...DONE, output: 'head', next_cursor: 4, dropped_bytes: 12, tail: 'tail' },
  })
  const result = await invoke(bag(), deps)
  assert.equal(result.ok, true)
  assert.equal(result.result.truncated, true)
  assert.equal(result.result.omitted_bytes, 12)
  assert.equal(result.result.stdout, 'head\n… [12 bytes omitted] …\ntail')
})

test('sandbox 前置失败（port.error）→ 原码透传，无 result', async () => {
  const { deps } = fakeDeps({ startError: new ToolError('fs_denied', 'outside workspace') })
  const result = await invoke(bag(), deps)
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'fs_denied', message: 'outside workspace' },
  })
})

test('未给 caps 时 exec_start 用 DEFAULT_CAPS', async () => {
  const { deps, startCalls } = fakeDeps()
  await invoke({ tool: 'shell', args: { input: 'echo' } }, deps)
  assert.deepEqual(startCalls[0].caps, DEFAULT_CAPS)
})

test('未知工具 / args 形态非法 / run 缺 input → 结构化错误', async () => {
  const { deps, startCalls } = fakeDeps()
  assert.equal(
    (await invoke({ tool: 'nope', args: { input: 'x' } }, deps)).error.code,
    'unknown_tool',
  )
  assert.equal((await invoke({ tool: 'shell', args: null }, deps)).error.code, 'bad_args')
  assert.equal((await invoke({ tool: 'shell', args: {} }, deps)).error.code, 'bad_args')
  assert.equal((await invoke({ tool: 'shell', args: { input: '' } }, deps)).error.code, 'bad_args')
  assert.equal(startCalls.length, 0)
})

// ── 密钥注入 ────────────────────────────────────────────────────────────────

test('auth_ref → secrets.resolve 被调；明文只出现在 exec_start 的 env', async () => {
  const secret = 's3cr3t-value'
  const { deps, startCalls, secretCalls } = fakeDeps({ secretValue: secret })
  const result = await invoke(bag({ auth_ref: { kind: 'local', name: 'TOKEN' } }), deps)
  assert.deepEqual(secretCalls, [{ kind: 'local', name: 'TOKEN' }])
  assert.deepEqual(startCalls[0].env, { TOKEN: secret })
  assert.equal(JSON.stringify(result).includes(secret), false, '明文不得进结果')
})

test('auth_ref 解析失败 → 原码透传，且不执行', async () => {
  const { deps, startCalls } = fakeDeps({
    secretError: new ToolError('secret_missing', 'not found'),
  })
  const result = await invoke(bag({ auth_ref: { kind: 'local', name: 'TOKEN' } }), deps)
  assert.deepEqual(result, { ok: false, error: { code: 'secret_missing', message: 'not found' } })
  assert.equal(startCalls.length, 0)
})

test('auth_ref 形态非法 → bad_auth_ref，且不调 secrets / exec', async () => {
  for (const authRef of [{ kind: 'local' }, 'nope']) {
    const { deps, startCalls, secretCalls } = fakeDeps()
    const result = await invoke(bag({ auth_ref: authRef }), deps)
    assert.equal(result.error.code, 'bad_auth_ref')
    assert.equal(secretCalls.length, 0)
    assert.equal(startCalls.length, 0)
  }
})
