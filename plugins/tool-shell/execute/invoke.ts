// `invoke`：单工具 `shell` 的动作分派（run / output / kill / reset）。
// 命令形态默认在常驻会话内执行（cd / env 跨调用延续）；`mode:code` 的 javascript / python 走一次性进程。
// 后台任务经 `sandbox.exec_start` 起、`exec_poll` 续读、`exec_kill` 终止；会话经 `session_close` 重开。
// 密钥经 `secrets.resolve` 取明文后只经 exec 的 `env` 字段下传子进程；明文不写入 args / 结果 / 日志 / event。
// sandbox 的错误原样透传（不吞、不改写）。

import path from 'node:path'

import { DEFAULT_CAPS, LANGUAGES } from './describe.ts'
import { DEFAULT_CALL_TIMEOUT_MS, MAX_CAPS_TIMEOUT_MS } from './backends.ts'
import { shellDigest } from './digest.ts'
import { ToolError, isRecord } from './types.ts'
import type { ShellProfile } from './describe.ts'
import type { ExecBackend, SecretsBackend } from './backends.ts'
import type { Json, Rec } from './types.ts'

export interface InvokeDeps {
  exec: ExecBackend
  secrets: SecretsBackend
  /** 平台原生 shell 口径（启动时探测注入）：命令形态的解释器与语法。 */
  profile: ShellProfile
  /** 调用中途发事件（`tool.delta`）的出口；缺省不发。 */
  emit?: (topic: string, payload: Rec) => void
}

/** 结果面：成功 `{ok:true, result}`，失败 `{ok:false, error:{code, message}}`（非零退出 / 被杀另带 result）。 */
export async function invoke(bag: Json, deps: InvokeDeps, sessionId = 'default'): Promise<Json> {
  try {
    return await run(bag, deps, sessionId)
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    throw err
  }
}

async function run(bag: Json, deps: InvokeDeps, sessionId: string): Promise<Json> {
  if (!isRecord(bag)) throw new ToolError('bad_args', 'invoke bag must be an object')
  if (bag['tool'] !== 'shell') throw new ToolError('unknown_tool', `unknown tool ${String(bag['tool'])}`)
  const args = bag['args']
  if (!isRecord(args)) throw new ToolError('bad_args', 'args must be an object')
  const action = args['action'] ?? 'run'
  if (action === 'output') return invokeOutput(args, deps)
  if (action === 'kill') return invokeKill(args, deps)
  if (action === 'reset') return invokeReset(bag, deps, sessionId)
  if (action !== 'run') throw new ToolError('bad_args', "action must be 'run' / 'output' / 'kill' / 'reset'")
  return invokeRun(args, bag, deps, sessionId)
}

async function invokeRun(args: Rec, bag: Rec, deps: InvokeDeps, sessionId: string): Promise<Json> {
  const input = args['input']
  if (typeof input !== 'string' || input.length === 0) {
    throw new ToolError('bad_args', 'input must be a non-empty string')
  }
  const mode = args['mode'] ?? 'command'
  if (mode !== 'command' && mode !== 'code') {
    throw new ToolError('bad_args', "mode must be 'command' or 'code'")
  }
  const language = mode === 'code' ? resolveLanguage(args['language']) : null
  optionalText(args['description'], 'description')
  const workdir = optionalText(args['workdir'], 'workdir')
  const requestedTimeout = optionalTimeout(args['timeout_ms'])
  const fresh = optionalBool(args['fresh'], 'fresh')
  const background = optionalBool(args['background'], 'background')
  const cwd = workdir === undefined ? undefined : resolveWorkdir(workdir, bag)
  const useSession = mode === 'command' || language === 'shell'

  if (fresh === true && useSession) {
    await deps.exec.sessionClose({ session_id: sessionId }, DEFAULT_CALL_TIMEOUT_MS)
  }

  if (background === true) {
    const invocation = resolveInvocation(mode, input, language, deps.profile)
    // 后台任务不套默认超时（否则长驻服务会被默认预算杀掉）；仅模型显式给 timeout_ms 时才限制。
    const caps = { ...effectiveCaps(bag, undefined), timeout_ms: requestedTimeout ?? 0 }
    const env = await buildEnv(bag, deps)
    const started = await deps.exec.start(buildExecArgs(bag, invocation, env, caps, cwd), DEFAULT_CALL_TIMEOUT_MS)
    return {
      ok: true,
      result: {
        kind: mode === 'code' ? 'json' : 'terminal',
        task_id: started['task_id'] ?? null,
        background: true,
        exit_code: null,
        stdout: '',
        stderr: '',
        truncated: false,
        omitted_bytes: 0,
        duration_ms: 0,
        digest: shellDigest(input, null, ''),
      },
    }
  }

  const env = await buildEnv(bag, deps)
  const caps = effectiveCaps(bag, requestedTimeout)
  const spec = useSession
    ? buildSessionBag(bag, deps.profile, sessionId, input, env, caps, cwd)
    : buildExecArgs(bag, resolveInvocation(mode, input, language, deps.profile), env, caps, cwd)
  const started = await deps.exec.start(spec, DEFAULT_CALL_TIMEOUT_MS)
  const taskId = typeof started['task_id'] === 'string' ? started['task_id'] : ''
  if (taskId.length === 0) throw new ToolError('tool_failed', 'sandbox.exec_start returned no task_id')
  return pumpToResult(taskId, mode, language, bag, deps, input)
}

/** 轮询等待上限：单次 `exec_poll` 最多阻塞这么久（宿主正向超时远高于它）。 */
const POLL_WAIT_MS = 300

/** 前台执行 = 起任务 + 轮询；新输出经 `tool.delta` 实时下发，结束按头尾口径组装最终结果。 */
async function pumpToResult(
  taskId: string,
  mode: string,
  language: string | null,
  bag: Rec,
  deps: InvokeDeps,
  command: string,
): Promise<Json> {
  const started = Date.now()
  const deltaBase = deltaContext(bag)
  let head = ''
  let cursor = 0
  let tail = ''
  let dropped = 0
  let exitCode: number | null = null
  let code: string | null = null
  for (;;) {
    const polled = await deps.exec.poll(
      { task_id: taskId, cursor, wait_ms: POLL_WAIT_MS },
      DEFAULT_CALL_TIMEOUT_MS,
    )
    const chunk = typeof polled['output'] === 'string' ? polled['output'] : ''
    if (chunk.length > 0) {
      head += chunk
      if (deltaBase !== null && deps.emit !== undefined) {
        deps.emit('tool.delta', { ...deltaBase, delta: chunk })
      }
    }
    cursor = typeof polled['next_cursor'] === 'number' ? polled['next_cursor'] : cursor
    if (typeof polled['tail'] === 'string') tail = polled['tail']
    if (typeof polled['dropped_bytes'] === 'number') dropped = polled['dropped_bytes']
    if (polled['running'] !== true) {
      exitCode = typeof polled['exit_code'] === 'number' ? polled['exit_code'] : null
      code = typeof polled['code'] === 'string' ? polled['code'] : null
      break
    }
  }
  const stdout = dropped > 0 ? `${head}\n… [${dropped} bytes omitted] …\n${tail}` : head + tail
  const outcome: Rec = {
    exit_code: exitCode,
    stdout,
    stderr: '',
    truncated: dropped > 0,
    omitted_bytes: dropped,
    combined: [{ stream: 'stdout', text: stdout }],
    combined_truncated: dropped > 0,
    duration_ms: Date.now() - started,
    code,
  }
  return executionResult(mode, language, outcome, command)
}

/** `tool.delta` 的关联键（缺模型 call_id 则不发）。 */
function deltaContext(bag: Rec): Rec | null {
  const callId = bag['call_id']
  if (typeof callId !== 'string' || callId.length === 0) return null
  const context: Rec = { call_id: callId }
  for (const key of ['run', 'thread']) {
    const value = bag[key]
    if (typeof value === 'string' && value.length > 0) context[key] = value
  }
  return context
}

async function invokeOutput(args: Rec, deps: InvokeDeps): Promise<Json> {
  const taskId = requireString(args['task_id'], 'task_id')
  const cursor = optionalInt(args['cursor'], 'cursor')
  const waitMs = optionalInt(args['wait_ms'], 'wait_ms')
  const wait = Math.min(waitMs ?? 0, MAX_CAPS_TIMEOUT_MS)
  const polled = await deps.exec.poll(
    { task_id: taskId, cursor: cursor ?? 0, wait_ms: wait },
    wait + DEFAULT_CALL_TIMEOUT_MS,
  )
  return {
    ok: true,
    result: {
      kind: 'terminal',
      task_id: taskId,
      stdout: typeof polled['output'] === 'string' ? polled['output'] : '',
      next_cursor: polled['next_cursor'] ?? 0,
      running: polled['running'] === true,
      exit_code: typeof polled['exit_code'] === 'number' ? polled['exit_code'] : null,
      code: typeof polled['code'] === 'string' ? polled['code'] : null,
      truncated: polled['truncated'] === true,
      dropped_bytes: typeof polled['dropped_bytes'] === 'number' ? polled['dropped_bytes'] : 0,
    },
  }
}

async function invokeKill(args: Rec, deps: InvokeDeps): Promise<Json> {
  const taskId = requireString(args['task_id'], 'task_id')
  const killed = await deps.exec.kill({ task_id: taskId }, DEFAULT_CALL_TIMEOUT_MS)
  return { ok: true, result: { kind: 'terminal', task_id: taskId, killed: killed['killed'] === true } }
}

async function invokeReset(bag: Rec, deps: InvokeDeps, sessionId: string): Promise<Json> {
  void bag
  const closed = await deps.exec.sessionClose({ session_id: sessionId }, DEFAULT_CALL_TIMEOUT_MS)
  return { ok: true, result: { kind: 'terminal', reset: true, closed: closed['closed'] === true } }
}

/** 可选文本参数：缺省回 undefined；出现但非非空字符串即 `bad_args`。 */
function optionalText(raw: Json | undefined, name: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ToolError('bad_args', `${name} must be a non-empty string`)
  }
  return raw
}

/** 必填非空字符串参数。 */
function requireString(raw: Json | undefined, name: string): string {
  const value = optionalText(raw, name)
  if (value === undefined) throw new ToolError('bad_args', `${name} required`)
  return value
}

/** 可选布尔参数：缺省回 undefined；出现但非布尔即 `bad_args`。 */
function optionalBool(raw: Json | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'boolean') throw new ToolError('bad_args', `${name} must be a boolean`)
  return raw
}

/** 可选非负整数参数。 */
function optionalInt(raw: Json | undefined, name: string): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ToolError('bad_args', `${name} must be a non-negative integer`)
  }
  return raw
}

/** 可选超时参数：缺省回 undefined；出现但非正安全整数即 `bad_args`。 */
function optionalTimeout(raw: Json | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new ToolError('bad_args', 'timeout_ms must be a positive integer')
  }
  return raw
}

/**
 * 工作目录：绝对路径原样；相对路径必须以 `bag.workspace_root` 为基准拼接。
 * 是否越出工作区由 sandbox 按当前档强制（本插件只做词法拼接，不触盘）。
 */
function resolveWorkdir(workdir: string, bag: Rec): string {
  if (path.isAbsolute(workdir)) return workdir
  const root = bag['workspace_root']
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new ToolError('bad_args', 'workdir relative path requires workspace_root')
  }
  return path.resolve(root, workdir)
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
  profile: ShellProfile,
): Invocation {
  if (mode === 'command') return shellInvocation(input, profile)
  if (language === 'javascript') return { cmd: 'node', args: ['-e', input] }
  if (language === 'python') return { cmd: profile.python, args: ['-c', input] }
  return shellInvocation(input, profile)
}

/** 命令形态统一走平台原生 shell（解释器 / 参数前缀 / 编码前导由启动探测注入）。 */
function shellInvocation(input: string, profile: ShellProfile): Invocation {
  const { cmd, argsPrefix, preamble } = profile.command
  const script = preamble !== undefined ? `${preamble}; ${input}` : input
  return { cmd, args: [...argsPrefix, script] }
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

function buildExecArgs(
  bag: Rec,
  invocation: Invocation,
  env: Rec,
  caps: Rec,
  cwd: string | undefined,
): Rec {
  const execArgs: Rec = {
    cmd: invocation.cmd,
    args: invocation.args,
    caps,
  }
  for (const key of ['tier', 'workspace_root', 'sandbox_tiers', 'grant']) {
    const value = bag[key]
    if (value !== undefined) execArgs[key] = value
  }
  if (cwd !== undefined) execArgs['cwd'] = cwd
  if (Object.keys(env).length > 0) execArgs['env'] = env
  return execArgs
}

/** 会话命令的 sandbox 入参：常驻 shell 口径 + 原始命令串 + 上下文。 */
function buildSessionBag(
  bag: Rec,
  profile: ShellProfile,
  sessionId: string,
  command: string,
  env: Rec,
  caps: Rec,
  cwd: string | undefined,
): Rec {
  const sessionBag: Rec = {
    session_id: sessionId,
    command,
    session_shell: {
      cmd: profile.session.cmd,
      args: [...profile.session.argsPrefix],
      syntax: profile.sessionSyntax,
    },
    caps,
  }
  for (const key of ['tier', 'workspace_root', 'sandbox_tiers', 'grant']) {
    const value = bag[key]
    if (value !== undefined) sessionBag[key] = value
  }
  if (cwd !== undefined) sessionBag['cwd'] = cwd
  if (Object.keys(env).length > 0) sessionBag['env'] = env
  return sessionBag
}

/**
 * 调用方声明优先；未声明时用工具声明的 DEFAULT_CAPS。
 * 模型传入的 `timeout_ms` 只能收紧、不能抬高：取 `min(请求, 声明上限)`。
 */
function effectiveCaps(bag: Rec, requestedTimeout: number | undefined): Rec {
  const declared = bag['caps']
  const caps = isRecord(declared) ? declared : { ...DEFAULT_CAPS }
  if (requestedTimeout === undefined) return caps
  const rawLimit = caps['timeout_ms']
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? rawLimit
      : DEFAULT_CAPS.timeout_ms
  return { ...caps, timeout_ms: Math.min(requestedTimeout, limit) }
}

function executionResult(mode: string, language: string | null, outcome: Rec, command: string): Json {
  const exitCode = typeof outcome['exit_code'] === 'number' ? outcome['exit_code'] : null
  const stdout = typeof outcome['stdout'] === 'string' ? outcome['stdout'] : ''
  const result: Rec = {
    kind: mode === 'code' ? 'json' : 'terminal',
    exit_code: exitCode,
    stdout,
    stderr: typeof outcome['stderr'] === 'string' ? outcome['stderr'] : '',
    truncated: outcome['truncated'] === true,
    omitted_bytes: typeof outcome['omitted_bytes'] === 'number' ? outcome['omitted_bytes'] : 0,
    combined: Array.isArray(outcome['combined']) ? (outcome['combined'] as Json) : [],
    combined_truncated: outcome['combined_truncated'] === true,
    duration_ms: typeof outcome['duration_ms'] === 'number' ? outcome['duration_ms'] : 0,
    digest: shellDigest(command, exitCode, stdout),
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
