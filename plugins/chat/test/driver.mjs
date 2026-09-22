// chat 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，
// 并自动应答反向调用 `port.call`（模拟宿主侧路由：把 #33 loop-policy.interpret 与
// #49 session-title.generate 两段假实现桥接给服务）。bridge 可注入以覆盖各段回值。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

export function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

/** 固定帧 env：thread = t1（决定槽键），now 固定（服务不自取时钟）。 */
export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 启动服务并返回请求 / 反向调用接口；`bridge(port, method, args)` 应答反向调用。 */
export function startService(options = {}) {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const bridge = options.bridge ?? (() => Promise.resolve({ value: null }))
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        Promise.resolve()
          .then(() => bridge(message.port, message.method, message.args))
          .then((outcome) => {
            const frame = outcome.error
              ? {
                  v: '1',
                  id: message.id,
                  kind: 'port.error',
                  ok: false,
                  error: outcome.error,
                  message: outcome.message ?? outcome.error,
                }
              : { v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome.value }
            child.stdin.write(encodeFrame(frame))
          })
          .catch((err) => {
            if (!child.stdin.writable) return
            child.stdin.write(
              encodeFrame({
                v: '1',
                id: message.id,
                kind: 'port.error',
                ok: false,
                error: 'bridge_failed',
                message: err instanceof Error ? err.message : String(err),
              }),
            )
          })
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  const timeoutMs = options.timeoutMs ?? 15000
  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  return {
    child,
    exit,
    events,
    portCalls,
    stderr,
    request,
    hello: () => request('hello', { impl: 'chat', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'chat', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

// ── 假下游服务（bridge 回值） ────────────────────────────────────────────────

/** #33 interpret 返回的写计划（回合尾一次写 + extern 摘要）。 */
export const INTERPRET_PLAN = {
  $directives: [
    {
      kind: 'write',
      request: {
        op: 'batch',
        args: {
          ops: [
            { op: 'put', args: { body: { id: 'msg-c-1-0', role: 'user' } } },
            { op: 'add_gen', args: { id: 'session', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
          ],
        },
      },
    },
    { kind: 'extern', payload: { ok: true, kind: 'interpret', ended: 'done' } },
  ],
}

export const TITLE_PLAN = {
  $directives: [
    {
      kind: 'write',
      request: {
        op: 'batch',
        args: { ops: [{ op: 'put', args: { body: { title: '快速排序' } } }] },
      },
    },
    { kind: 'extern', payload: { ok: true, conversation: 'c-1', title: '快速排序' } },
  ],
}

/** 默认 bridge：#33 interpret 与 #49 title 两段都回成功计划。 */
export function defaultBridge(overrides = {}) {
  const table = {
    'loop-policy.interpret': () => INTERPRET_PLAN,
    'session-title.generate': () => TITLE_PLAN,
    ...overrides,
  }
  return (port, method) => {
    const fn = table[`${port}.${method}`]
    return Promise.resolve(fn === undefined ? { error: 'not_ready', message: 'no fake' } : { value: fn() })
  }
}

// ── 投影夹具 ────────────────────────────────────────────────────────────────

const hex = (char) => char.repeat(64)

export const HASHES = {
  contract: hex('b'),
  graph: hex('a'),
  instance: hex('c'),
  prompt: hex('d'),
  todo: hex('e'),
}

/** 一份最小 config body（连接实例 + 档案 + 风格 + 权限档）。 */
export function configFixture(overrides = {}) {
  return {
    version: 1,
    vendor: 'deepseek',
    model: 'deepseek-chat',
    params: { temperature: 0.3 },
    permission: 'review',
    ui: { style: '简洁' },
    providers: {
      deepseek: {
        base_url: 'https://api.deepseek.com',
        auth_ref: { kind: 'env', name: 'DEEPSEEK_API_KEY' },
        models: { 'deepseek-chat': { context_window: 65536, max_output: 8192 } },
      },
    },
    ...overrides,
  }
}

/** 一份最小 short-memory body（本会话 L1 + 工作区 L2）。 */
export function memoryFixture() {
  return {
    version: 1,
    sessions: {
      'c-1': {
        summary: { goal: '写排序', decisions: [], facts: [], open_questions: [], files: [], next_steps: [] },
        covered_upto: null,
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2999-01-01T00:00:00.000Z',
      },
    },
    workspaces: {
      'w-1': {
        summary: { goal: 'w', decisions: [], facts: [], open_questions: [], files: [] },
        sources: ['c-1'],
        at: '2020-01-01T00:00:00.000Z',
      },
    },
  }
}

/** 一条会话链：h1 → h2 → h3（旧 → 新）。 */
export function chainRefs() {
  return {
    h1: { id: 'm1', role: 'user', content: '一', prev: null },
    h2: { id: 'm2', role: 'assistant', content: '二', prev: { def: 'h1' } },
    h3: { id: 'm3', role: 'user', content: '三', prev: { def: 'h2' } },
  }
}

/** #33 六类条目投影（链式 tail + refs 闭包）。 */
export function loopPolicyFixture() {
  return {
    body: {
      version: 1,
      contracts: { tail: { def: HASHES.contract }, count: 1 },
      nodes: { tail: null, count: 0 },
      prompts: { tail: null, count: 0 },
      graph: { def: HASHES.graph },
      thresholds: { tail: null, count: 0 },
      refusal_codes: { tail: null, count: 0 },
    },
    refs: {
      [HASHES.contract]: { contract_id: 'context.assemble', prev: null },
      [HASHES.graph]: {
        nodes: ['context.assemble'],
        edges: [],
        entry_supply: [],
        loop: { when: '' },
        sink: 0,
      },
    },
  }
}

export function guardFixture() {
  return {
    version: 1,
    tiers: {
      auto: { outside: false, danger: false, mcp: true, structural: false },
      review: { outside: true, danger: true, mcp: true, structural: true },
      deny: { outside: true, danger: true, mcp: true, structural: true },
    },
    workspace: { enabled: true, verdict: 'escalate', call_path_keys: ['path'], arg_path_keys: ['path', 'paths'] },
    danger_patterns: [],
    mcp: { port: 'mcp', default_verdict: 'escalate', trusted: [] },
    structural_writes: [],
    deny: { calls: [], allowed_ports: null },
  }
}

export function sandboxFixture() {
  return {
    version: 1,
    impl: 'native',
    tiers: {
      auto: { fs: { read: 'full', write: 'full' }, net: 'all' },
      review: { fs: { read: 'workspace', write: 'none' }, net: 'none' },
      deny: { fs: { read: 'none', write: 'none' }, net: 'none' },
    },
    defaults: { timeout_ms: 30000, mem_mb: 1024, cpu_ms: 0, output_max: 1048576, procs_max: 32 },
    net_hosts: [],
    docker_image: 'alpine:3',
  }
}

export function toolsFixture() {
  return {
    version: 1,
    bindings: {
      'retrieval.search': { class: 'retrieval', method: 'search', argsSchema: { type: 'object' }, caps: {}, idempotent: true },
    },
  }
}

export function mcpFixture() {
  return { version: 1, servers: [], tools: [{ name: 'mcp.demo.echo' }] }
}

export function evolutionFixture() {
  return {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: null, count: 0 },
    verdicts: { tail: null, count: 0 },
  }
}

/** #47 todo 投影：本会话一条 pending 条目。 */
export function todoFixture() {
  return {
    body: { conversations: { 'c-1': { items: { tail: { def: HASHES.todo }, count: 1 } } } },
    refs: { [HASHES.todo]: { id: 't1', text: '写排序', status: 'pending', prev: null } },
  }
}

export function workspaceFixture() {
  return { version: 1, workspaces: [{ id: 'w-1', name: '工作区', path: 'C:/ws/w-1' }] }
}

/** #35 agents 投影：一条实例人格（system_prompt 经 refs 指向提示词 def）。 */
export function agentsFixture() {
  return {
    body: {
      version: 1,
      templates: { tail: null, count: 0 },
      instances: { tail: { def: HASHES.instance }, count: 1 },
      channels: { tail: null, count: 0 },
    },
    refs: {
      [HASHES.instance]: {
        id: 'agent-a',
        name: '评审员',
        system_prompt: { def: HASHES.prompt },
        scope: { kind: 'global' },
        prev: null,
      },
      [HASHES.prompt]: { id: 'p', text: '你是代码评审员。' },
    },
  }
}

export function skillFixture() {
  return { version: 1, skills: [{ id: 's1', name: '排序', triggers: { keywords: ['排序'] }, body: '技能说明' }] }
}

/** 投影 `ids` 夹具：入口 term 传 `["g",["ids"]]` 得到的就是它（含 interpret bag 全切片）。 */
export function idsFixture(overrides = {}) {
  const conversation = {
    id: 'c-1',
    title: '新对话',
    count: 0,
    kind: 'main',
    workspace_id: 'w-1',
    agent: overrides.agent ?? null,
    head: { def: 'h3' },
    ...(overrides.conversation ?? {}),
  }
  const todo = todoFixture()
  const agents = agentsFixture()
  const ids = {
    input: {
      body: {
        slots: {
          t1: overrides.slot ?? { kind: 'chat.message', text: '帮我写一个快速排序' },
          ...(overrides.extraSlots ?? {}),
        },
      },
    },
    config: { body: overrides.configBody ?? configFixture() },
    'short-memory': { body: overrides.memoryBody ?? memoryFixture() },
    session: {
      body: { version: 1, current: 'c-1', conversations: [conversation] },
      refs: overrides.refs ?? chainRefs(),
    },
    'loop-policy': overrides.loopPolicy ?? loopPolicyFixture(),
    guard: { body: guardFixture() },
    sandbox: { body: sandboxFixture() },
    tools: { body: toolsFixture() },
    mcp: { body: mcpFixture() },
    evolution: { body: evolutionFixture() },
    todo: { body: todo.body, refs: todo.refs },
    workspace: { body: workspaceFixture() },
    agents: { body: agents.body, refs: agents.refs },
    skill: { body: skillFixture() },
  }
  for (const key of overrides.omit ?? []) delete ids[key]
  return ids
}

/** 从结果值里取计划条目。 */
export function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

/** 从计划值里取 extern 载荷（无则 null）。 */
export function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  return extern?.payload ?? null
}

/** 取某段反向调用的 args（无则 null）。 */
export function callArgs(portCalls, port, method) {
  const call = portCalls.find((frame) => frame.port === port && frame.method === method)
  return call === undefined ? null : call.args
}
