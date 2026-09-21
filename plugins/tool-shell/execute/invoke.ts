// `invoke`：把单工具 `shell` 映射为一次 `sandbox.exec` 反向调用。
// 两种输入形态共用同一隔离与审计路径：command 经平台 shell，code 按语言白名单起 node / python / shell。
// 密钥经 `secrets.resolve` 取明文后只经 exec 的 `env` 字段下传子进程；明文不写入 args / 结果 / 日志 / event。
// sandbox 的错误原样透传（不吞、不改写）。

import { DEFAULT_CAPS, LANGUAGES } from './describe.ts'
import { ToolError, isRecord } from './types.ts'
import type { ExecBackend, SecretsBackend } from './port-link.ts'
import type { Json, Rec } from './types.ts'

export interface InvokeDeps {
  exec: ExecBackend
  secrets: SecretsBackend
  platform: string
}

/** 结果面：成功 `{ok:true, result}`，失败 `{ok:false, error:{code, message}}`（非零退出 / 被杀另带 result）。 */
export async function invoke(bag: Json, deps: InvokeDeps): Promise<Json> {
  try {
    return await run(bag, deps)
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    throw err
  }
}

async function run(bag: Json, deps: InvokeDeps): Promise<Json> {
  if (!isRecord(bag)) throw new ToolError('bad_args', 'invoke bag must be an object')
  if (bag['tool'] !== 'shell') throw new ToolError('unknown_tool', `unknown tool ${String(bag['tool'])}`)
  const args = bag['args']
  if (!isRecord(args)) throw new ToolError('bad_args', 'args must be an object')
  const input = args['input']
  if (typeof input !== 'string' || input.length === 0) {
    throw new ToolError('bad_args', 'input must be a non-empty string')
  }
  const mode = args['mode'] ?? 'command'
  if (mode !== 'command' && mode !== 'code') {
    throw new ToolError('bad_args', "mode must be 'command' or 'code'")
  }
  const language = mode === 'code' ? resolveLanguage(args['language']) : null
  const invocation = resolveInvocation(mode, input, language, deps.platform)
  const env = await buildEnv(bag, deps)
  const outcome = await deps.exec.exec(buildExecArgs(bag, invocation, env))
  return executionResult(mode, language, outcome)
}

function resolveLanguage(raw: Json | undefined): string {
  if (typeof raw !== 'string' || !LANGUAGES.includes(raw)) {
    throw new ToolError('code_unsupported_language', `unsupported language ${String(raw)}`)
  }
  return raw
}

interface Invocation {
  cmd: string
  args: string[]
}

function resolveInvocation(
  mode: string,
  input: string,
  language: string | null,
  platform: string,
): Invocation {
  if (mode === 'command') return shellInvocation(input, platform)
  if (language === 'javascript') return { cmd: 'node', args: ['-e', input] }
  if (language === 'python') return { cmd: 'python', args: ['-c', input] }
  return shellInvocation(input, platform)
}

/** 平台 shell：win32 用 cmd.exe，其余用 /bin/sh。 */
function shellInvocation(input: string, platform: string): Invocation {
  if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/c', input] }
  return { cmd: '/bin/sh', args: ['-c', input] }
}

/** 合法环境变量名：字母 / 下划线开头，后续字母数字下划线（POSIX 口径）。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 密钥注入：解析 `bag.auth_ref` 得明文，只挂到 exec 的 `env`（键 = 引用名）。 */
async function buildEnv(bag: Rec, deps: InvokeDeps): Promise<Rec> {
  const env: Rec = {}
  const authRef = bag['auth_ref']
  if (authRef === undefined) return env
  if (!isRecord(authRef)) throw new ToolError('bad_auth_ref', 'auth_ref must be an object')
  const name = authRef['name']
  if (typeof name !== 'string' || !ENV_NAME.test(name)) {
    throw new ToolError('bad_auth_ref', 'auth_ref.name must be a valid environment variable name')
  }
  const plaintext = await deps.secrets.resolve(authRef)
  env[name] = plaintext
  return env
}

function buildExecArgs(bag: Rec, invocation: Invocation, env: Rec): Rec {
  const execArgs: Rec = {
    cmd: invocation.cmd,
    args: invocation.args,
    caps: effectiveCaps(bag),
  }
  for (const key of ['tier', 'workspace_root', 'sandbox_tiers', 'grant']) {
    const value = bag[key]
    if (value !== undefined) execArgs[key] = value
  }
  if (Object.keys(env).length > 0) execArgs['env'] = env
  return execArgs
}

/** 调用方声明优先；未声明时用工具声明的 DEFAULT_CAPS。 */
function effectiveCaps(bag: Rec): Rec {
  const declared = bag['caps']
  return isRecord(declared) ? declared : { ...DEFAULT_CAPS }
}

function executionResult(mode: string, language: string | null, outcome: Rec): Json {
  const exitCode = typeof outcome['exit_code'] === 'number' ? outcome['exit_code'] : null
  const stdout = typeof outcome['stdout'] === 'string' ? outcome['stdout'] : ''
  const result: Rec = {
    kind: mode === 'code' ? 'json' : 'terminal',
    exit_code: exitCode,
    stdout,
    stderr: typeof outcome['stderr'] === 'string' ? outcome['stderr'] : '',
    truncated: outcome['truncated'] === true,
    duration_ms: typeof outcome['duration_ms'] === 'number' ? outcome['duration_ms'] : 0,
  }
  if (mode === 'code') {
    result['language'] = language
    result['value'] = parseJsonOutput(stdout)
  }
  const killed = outcome['code']
  if (typeof killed === 'string' && killed.length > 0) {
    return { ok: false, error: { code: killed, message: `exec killed: ${killed}` }, result }
  }
  if (exitCode !== null && exitCode !== 0) {
    return { ok: false, error: { code: 'nonzero_exit', message: `command exited with code ${exitCode}` }, result }
  }
  return { ok: true, result }
}

/** code 形态的结构化结果：stdout 是 JSON 就解析，否则回 null。 */
function parseJsonOutput(stdout: string): Json {
  const text = stdout.trim()
  if (text.length === 0) return null
  try {
    return JSON.parse(text) as Json
  } catch {
    return null
  }
}
