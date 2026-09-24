// `tool-shell` invoke 单元测试：两种 mode 的 exec args 编解码、密钥注入、错误码映射与白名单。
// 反向调用抽成可注入接口（ExecBackend / SecretsBackend），用假后端捕获 exec / secrets 入参。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { invoke } from '../execute/invoke.ts'
import { DEFAULT_CAPS } from '../execute/describe.ts'
import {
  DEFAULT_CALL_TIMEOUT_MS,
  HOST_METHOD_TIMEOUT_MS,
  MAX_CAPS_TIMEOUT_MS,
  REVERSE_TIMEOUT_MARGIN_MS,
} from '../execute/port-link.ts'
import { ToolError } from '../execute/types.ts'

const OK_OUTCOME = {
  exit_code: 0,
  stdout: '',
  stderr: '',
  truncated: false,
  duration_ms: 1,
  code: null,
}

function fakeDeps(options = {}) {
  const execCalls = []
  const execMeta = []
  const secretCalls = []
  const secretMeta = []
  const deps = {
    platform: options.platform ?? 'win32',
    exec: {
      async exec(args, callId, timeoutMs) {
        execCalls.push(args)
        execMeta.push({ callId, timeoutMs })
        if (options.execError) throw options.execError
        return options.execResult ?? OK_OUTCOME
      },
    },
    secrets: {
      async resolve(authRef, callId) {
        secretCalls.push(authRef)
        secretMeta.push({ callId })
        if (options.secretError) throw options.secretError
        return options.secretValue ?? 'secret-value'
      },
    },
  }
  return { deps, execCalls, execMeta, secretCalls, secretMeta }
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

test('command 模式：经平台 shell 起命令，tier / workspace_root / caps / grant 透传', async () => {
  const { deps, execCalls } = fakeDeps({ execResult: { ...OK_OUTCOME, stdout: 'hi\n' } })
  const result = await invoke(bag(), deps)
  assert.equal(result.ok, true)
  assert.equal(result.result.kind, 'terminal')
  assert.equal(result.result.exit_code, 0)
  assert.equal(result.result.stdout, 'hi\n')
  assert.equal(execCalls.length, 1)
  assert.equal(execCalls[0].cmd, 'cmd.exe')
  assert.deepEqual(execCalls[0].args, ['/c', 'echo hi'])
  assert.equal(execCalls[0].tier, 'severe')
  assert.equal(execCalls[0].workspace_root, 'C:\\ws')
  assert.deepEqual(execCalls[0].caps, { fs: { read: 'workspace', write: 'workspace' }, net: 'none' })
  assert.deepEqual(execCalls[0].grant, { call_id: 'g1' })
  assert.deepEqual(execCalls[0].sandbox_tiers, { version: 1 })
  assert.equal(execCalls[0].env, undefined)
})

test('command 模式：非 win32 用 /bin/sh -c', async () => {
  const { deps, execCalls } = fakeDeps({ platform: 'linux' })
  await invoke(bag(), deps)
  assert.equal(execCalls[0].cmd, '/bin/sh')
  assert.deepEqual(execCalls[0].args, ['-c', 'echo hi'])
})

test('mode 缺省 = command', async () => {
  const { deps, execCalls } = fakeDeps()
  await invoke({ tool: 'shell', args: { input: 'pwd' } }, deps)
  assert.equal(execCalls[0].cmd, 'cmd.exe')
})

test('code 模式 javascript / python / shell：按白名单选解释器', async () => {
  const cases = [
    { language: 'javascript', platform: 'win32', cmd: 'node', args: ['-e', 'console.log(1)'] },
    { language: 'python', platform: 'win32', cmd: 'python', args: ['-c', 'print(1)'] },
    { language: 'shell', platform: 'win32', cmd: 'cmd.exe', args: ['/c', 'echo 1'] },
    { language: 'shell', platform: 'linux', cmd: '/bin/sh', args: ['-c', 'echo 1'] },
  ]
  for (const item of cases) {
    const { deps, execCalls } = fakeDeps({ platform: item.platform })
    const input = item.language === 'javascript' ? 'console.log(1)' : item.language === 'python' ? 'print(1)' : 'echo 1'
    const result = await invoke(
      { tool: 'shell', args: { mode: 'code', language: item.language, input } },
      deps,
    )
    assert.equal(execCalls[0].cmd, item.cmd, item.language)
    assert.deepEqual(execCalls[0].args, item.args, item.language)
    assert.equal(result.result.kind, 'json')
    assert.equal(result.result.language, item.language)
  }
})

test('code 模式：stdout 是 JSON 时解析进 result.value', async () => {
  const { deps } = fakeDeps({ execResult: { ...OK_OUTCOME, stdout: '{"a":1}\n' } })
  const result = await invoke({ tool: 'shell', args: { mode: 'code', language: 'javascript', input: 'x' } }, deps)
  assert.deepEqual(result.result.value, { a: 1 })
})

test('code 模式：stdout 非 JSON 时 value 为 null', async () => {
  const { deps } = fakeDeps({ execResult: { ...OK_OUTCOME, stdout: 'not json' } })
  const result = await invoke({ tool: 'shell', args: { mode: 'code', language: 'python', input: 'x' } }, deps)
  assert.equal(result.result.value, null)
})

test('白名单外语言 / 缺 language → code_unsupported_language，且不执行', async () => {
  for (const args of [
    { mode: 'code', language: 'ruby', input: 'x' },
    { mode: 'code', input: 'x' },
  ]) {
    const { deps, execCalls, secretCalls } = fakeDeps()
    const result = await invoke({ tool: 'shell', args }, deps)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'code_unsupported_language')
    assert.equal(execCalls.length, 0)
    assert.equal(secretCalls.length, 0)
  }
})

test('非零退出 → nonzero_exit，结果仍回带 exit_code', async () => {
  const { deps } = fakeDeps({ execResult: { ...OK_OUTCOME, exit_code: 3, stdout: 'boom', stderr: 'err' } })
  const result = await invoke(bag(), deps)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'nonzero_exit')
  assert.equal(result.result.exit_code, 3)
  assert.equal(result.result.stdout, 'boom')
  assert.equal(result.result.stderr, 'err')
})

test('资源超限被杀（code=timeout）→ 原码透传，结果仍回', async () => {
  const { deps } = fakeDeps({ execResult: { ...OK_OUTCOME, exit_code: null, code: 'timeout' } })
  const result = await invoke(bag(), deps)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'timeout')
  assert.equal(result.result.exit_code, null)
})

test('输出截断（truncated:true）是标记非错', async () => {
  const { deps } = fakeDeps({ execResult: { ...OK_OUTCOME, truncated: true, stdout: 'partial' } })
  const result = await invoke(bag(), deps)
  assert.equal(result.ok, true)
  assert.equal(result.result.truncated, true)
})

test('sandbox 前置失败（port.error）→ 原码透传，无 result', async () => {
  const { deps } = fakeDeps({ execError: new ToolError('fs_denied', 'outside workspace') })
  const result = await invoke(bag(), deps)
  assert.deepEqual(result, { ok: false, error: { code: 'fs_denied', message: 'outside workspace' } })
})

test('未给 caps 时 exec 用 DEFAULT_CAPS', async () => {
  const { deps, execCalls } = fakeDeps()
  await invoke({ tool: 'shell', args: { input: 'echo' } }, deps)
  assert.deepEqual(execCalls[0].caps, DEFAULT_CAPS)
})

test('未知工具 / args 形态非法 / input 缺失 → 结构化错误', async () => {
  const { deps, execCalls } = fakeDeps()
  assert.equal((await invoke({ tool: 'nope', args: { input: 'x' } }, deps)).error.code, 'unknown_tool')
  assert.equal((await invoke({ tool: 'shell', args: null }, deps)).error.code, 'bad_args')
  assert.equal((await invoke({ tool: 'shell', args: {} }, deps)).error.code, 'bad_args')
  assert.equal((await invoke({ tool: 'shell', args: { input: '' } }, deps)).error.code, 'bad_args')
  assert.equal(execCalls.length, 0)
})

// ── 密钥注入 ────────────────────────────────────────────────────────────────

test('auth_ref → secrets.resolve 被调；明文只出现在 exec 的 env', async () => {
  const secret = 's3cr3t-value'
  const { deps, execCalls, secretCalls } = fakeDeps({ secretValue: secret })
  const result = await invoke(
    bag({ auth_ref: { kind: 'local', name: 'TOKEN' } }),
    deps,
  )

  // secrets.resolve 收到的是引用，不是明文
  assert.deepEqual(secretCalls, [{ kind: 'local', name: 'TOKEN' }])

  // 明文只挂在 exec 的 env
  assert.deepEqual(execCalls[0].env, { TOKEN: secret })

  // 明文不出现在结果、exec 的其余字段、secrets 入参
  assert.equal(JSON.stringify(result).includes(secret), false, '明文不得进结果')
  const { env, ...execRest } = execCalls[0]
  assert.equal(JSON.stringify(execRest).includes(secret), false, '明文只许在 exec.env')
  assert.equal(JSON.stringify(secretCalls).includes(secret), false, '明文不得进 secrets 入参')
})

test('auth_ref 解析失败 → 原码透传，且不执行', async () => {
  const { deps, execCalls } = fakeDeps({ secretError: new ToolError('secret_missing', 'not found') })
  const result = await invoke(bag({ auth_ref: { kind: 'local', name: 'TOKEN' } }), deps)
  assert.deepEqual(result, { ok: false, error: { code: 'secret_missing', message: 'not found' } })
  assert.equal(execCalls.length, 0)
})

test('auth_ref 形态非法 → bad_auth_ref，且不调 secrets / exec', async () => {
  for (const authRef of [{ kind: 'local' }, 'nope']) {
    const { deps, execCalls, secretCalls } = fakeDeps()
    const result = await invoke(bag({ auth_ref: authRef }), deps)
    assert.equal(result.error.code, 'bad_auth_ref')
    assert.equal(secretCalls.length, 0)
    assert.equal(execCalls.length, 0)
  }
})

test('auth_ref.name 非法环境变量名 → bad_auth_ref，且不调 secrets / exec', async () => {
  for (const name of ['BAD-NAME', '1ABC', 'has space', 'a.b', '']) {
    const { deps, execCalls, secretCalls } = fakeDeps()
    const result = await invoke(bag({ auth_ref: { kind: 'local', name } }), deps)
    assert.equal(result.error.code, 'bad_auth_ref', `name=${JSON.stringify(name)}`)
    assert.equal(secretCalls.length, 0)
    assert.equal(execCalls.length, 0)
  }
})

// ── 反向等待超时与 call_id 回带 ─────────────────────────────────────────────

test('反向等待按声明 timeout_ms 加固定余量，并回带发起 call 帧 id', async () => {
  const { deps, execMeta } = fakeDeps()
  await invoke(bag({ caps: { timeout_ms: 12000 } }), deps, 'call-7')
  assert.equal(execMeta[0].callId, 'call-7')
  assert.equal(execMeta[0].timeoutMs, 12000 + REVERSE_TIMEOUT_MARGIN_MS)
})

test('未声明 caps 时反向等待按工具声明 timeout_ms 加余量', async () => {
  const { deps, execMeta } = fakeDeps()
  await invoke({ tool: 'shell', args: { input: 'echo' } }, deps)
  assert.equal(execMeta[0].timeoutMs, DEFAULT_CAPS.timeout_ms + REVERSE_TIMEOUT_MARGIN_MS)
})

test('声明 caps 但缺 timeout_ms 时回落通道兜底加余量', async () => {
  const { deps, execMeta } = fakeDeps()
  await invoke(bag({ caps: { net: 'none' } }), deps)
  assert.equal(execMeta[0].timeoutMs, DEFAULT_CALL_TIMEOUT_MS + REVERSE_TIMEOUT_MARGIN_MS)
})

test('声明超预算的 timeout_ms 被 clamp 在宿主预算内：host > reverse > exec', async () => {
  const { deps, execMeta } = fakeDeps()
  await invoke(bag({ caps: { timeout_ms: 999999 } }), deps)
  const reverse = MAX_CAPS_TIMEOUT_MS + REVERSE_TIMEOUT_MARGIN_MS
  assert.equal(execMeta[0].timeoutMs, reverse)
  assert.ok(reverse < HOST_METHOD_TIMEOUT_MS, '反向等待必须小于宿主正向超时')
  assert.ok(MAX_CAPS_TIMEOUT_MS < reverse, '执行预算必须小于反向等待')
})

test('auth_ref 的 secrets.resolve 回带发起 call 帧 id', async () => {
  const { deps, secretMeta } = fakeDeps()
  await invoke(bag({ auth_ref: { kind: 'local', name: 'TOKEN' } }), deps, 'call-9')
  assert.equal(secretMeta[0].callId, 'call-9')
})
