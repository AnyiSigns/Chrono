// 协议级测试驱动：spawn `tools` 门面 `node execute/main.ts`，发 hello / call 帧；把门面的反向调用经
// **多跳 spawn 桥**转发到三个下游插件的**真实服务进程**（`tool-schema` / `tool-registry` / `tool-dispatch`，
// 不 import 兄弟插件源码），并递归转发多跳反向调用（tools → tool-registry / tool-dispatch → tool-schema /
// 各工具提供者），模拟宿主按 pins 路由。假提供者用 `{ <port>: { <method>: (args) => value | {ok,...} } }`
// 注入（优先于下游真实服务）；事件与反向调用帧全局汇总。
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { relayFrame, serviceEntry, startBridgedService } from './bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const SCHEMA_ROOT = resolve(PKG_ROOT, '..', 'tool-schema')
const REGISTRY_ROOT = resolve(PKG_ROOT, '..', 'tool-registry')
const DISPATCH_ROOT = resolve(PKG_ROOT, '..', 'tool-dispatch')

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/**
 * 宿主注入的**有效 pins**（声明 `pins` ∪ one-needs 绑定）：键为逻辑端口名、值为提供方身份名。
 * 门面只余 `host` 声明 + 两个下游 one-needs；下游各自按自身 needs 注入。
 */
export const FACADE_PINS = {
  host: 'host',
  'tool-registry': 'tool-registry',
  'tool-dispatch': 'tool-dispatch',
}
export const REGISTRY_PINS = {
  'tool-schema': 'tool-schema',
  session: 'session',
  compress: 'compress',
  memory: 'memory-store',
  retrieval: 'memory-retrieval',
  'memory-maintenance': 'memory-consolidate',
  'evolve-metrics': 'evolve-metrics',
}
export const DISPATCH_PINS = {
  'tool-registry': 'tool-registry',
  'tool-schema': 'tool-schema',
  guard: 'guard',
  session: 'session',
  compress: 'compress',
  memory: 'memory-store',
  retrieval: 'memory-retrieval',
  'memory-maintenance': 'memory-consolidate',
  'evolve-metrics': 'evolve-metrics',
}

/**
 * 扩展类 `tool-provider` 的世界成员（宿主按世界能力索引注入；提供方身份名，码元序）。
 * 加 / 减成员 = 世界变更；`tool-registry` 代码与声明零改动。
 */
export const MANY_NEEDS = {
  'tool-provider': [
    'mcp',
    'orchestration-admin',
    'plugin-admin',
    'question',
    'todo',
    'tool-browser',
    'tool-fs',
    'tool-http',
    'tool-shell',
  ],
}

/** 兼容旧引用：门面有效 pins。 */
export const DEFAULT_PINS = FACADE_PINS

/**
 * 启动门面与三个下游真实服务并返回请求 / 反向调用接口。`providers` 可后续用 `setProvider` 修改
 * （同一对象引用）；反向调用按「假提供者优先，其次真实下游服务，最后 unresolved_cap」递归路由。
 * `options.services` 追加真实下游服务（如夹具工具插件）；`options.manyNeeds` 覆盖成员表。
 */
export function startService(options = {}) {
  const providers = options.providers ?? {}
  const timeoutMs = options.timeoutMs ?? 15000
  const manyNeeds = { ...MANY_NEEDS, ...(options.manyNeeds ?? {}) }

  const schema = startBridgedService({
    cwd: SCHEMA_ROOT,
    entry: serviceEntry(SCHEMA_ROOT),
    timeoutMs,
  })
  const registry = startBridgedService({
    cwd: REGISTRY_ROOT,
    entry: serviceEntry(REGISTRY_ROOT),
    timeoutMs,
    env: {
      CHRONO_PLUGIN_PINS: JSON.stringify(REGISTRY_PINS),
      CHRONO_PLUGIN_MANY_NEEDS: JSON.stringify(manyNeeds),
    },
    onPortCall: (message) => route('tool-registry', message),
  })
  const dispatch = startBridgedService({
    cwd: DISPATCH_ROOT,
    entry: serviceEntry(DISPATCH_ROOT),
    timeoutMs,
    env: { CHRONO_PLUGIN_PINS: JSON.stringify(DISPATCH_PINS) },
    onPortCall: (message) => route('tool-dispatch', message),
  })
  const tools = startBridgedService({
    cwd: PKG_ROOT,
    entry: serviceEntry(PKG_ROOT),
    timeoutMs,
    env: { CHRONO_PLUGIN_PINS: JSON.stringify(options.pins ?? FACADE_PINS) },
    onPortCall: (message) => route('tools', message),
  })
  const services = {
    'tool-schema': schema,
    'tool-registry': registry,
    'tool-dispatch': dispatch,
    tools,
    ...(options.services ?? {}),
  }

  /** 递归路由一次反向调用：假提供者优先，其次真实下游服务，未知端口回 unresolved_cap。 */
  async function route(_origin, frame) {
    // 按成员定位的 many：帧 `provider` = 目标提供方身份名；否则为单值端口。
    const dest = typeof frame.provider === 'string' ? frame.provider : frame.port
    const fake = providers[dest]?.[frame.method]
    if (typeof fake === 'function') {
      try {
        const value = await fake(frame.args ?? {})
        return { ok: true, value: value === undefined ? null : value }
      } catch (err) {
        return { ok: false, code: 'bridge_failed', message: String(err?.message ?? err) }
      }
    }
    const downstream = services[dest]
    if (downstream === undefined) {
      return {
        ok: false,
        code: 'unresolved_cap',
        message: `no provider ${String(dest)}.${String(frame.method)}`,
      }
    }
    return relayFrame(await downstream.call(frame.port, frame.method, frame.args ?? {}, frame.env))
  }

  return {
    child: tools.child,
    get events() {
      return [...tools.events, ...dispatch.events, ...registry.events, ...schema.events]
    },
    get portCalls() {
      return [...tools.portCalls, ...dispatch.portCalls, ...registry.portCalls, ...schema.portCalls]
    },
    get stderr() {
      return [...tools.stderr, ...dispatch.stderr, ...registry.stderr, ...schema.stderr]
    },
    exit: Promise.all([tools.exit, dispatch.exit, registry.exit, schema.exit]).then(() => 0),
    providers,
    request: (...args) => tools.request(...args),
    setProvider(port, method, fn) {
      providers[port] = { ...(providers[port] ?? {}), [method]: fn }
    },
    removeProvider(port, method) {
      if (providers[port] !== undefined) delete providers[port][method]
    },
    hello: () => tools.hello('tools'),
    call: (method, args, env = FIXED_ENV) => tools.call('tools', method, args, env),
    close() {
      tools.close()
      dispatch.close()
      registry.close()
      schema.close()
      for (const service of Object.values(options.services ?? {})) service.close()
    },
  }
}

/** 一个合法工具声明（四要素齐备、caps 对象形、argsSchema 白名单子集）。 */
export function toolDecl(overrides = {}) {
  return {
    name: 'read',
    intent: '读取一个文本文件的内容。',
    when_to_use: '需要查看文件内容时。',
    param_semantics: { path: '文件路径。' },
    boundaries: '只读单文件；找文件用 glob。',
    description: '读文本文件；返回 {text}。',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    caps: { fs: { read: 'workspace', write: 'none' }, net: 'none' },
    idempotent: false,
    render: { form: 'line', label: 'read', summary: '{path}' },
    ...overrides,
  }
}

/** 一个合法绑定项。 */
export function bindingItem(overrides = {}) {
  return {
    class: 'retrieval',
    method: 'search',
    intent: '检索长期记忆。',
    when_to_use: '需要语义召回记忆时。',
    param_semantics: { query: '检索词。' },
    boundaries: '只读检索；写入用 memory。',
    argsSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: true,
    },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
    idempotent: true,
    ...overrides,
  }
}

/** `record` 的规范绑定项（工具名 `record` 直绑 `evolve-metrics.record`；idempotent:false）。 */
export function recordBinding(overrides = {}) {
  return {
    class: 'evolve-metrics',
    method: 'record',
    intent: '把用户原始请求落成一条 user_request 证据。',
    when_to_use: '用户驱动结构变更、需先留证再交提案时。',
    param_semantics: {
      user_message_def: '本回合首条用户消息 def（由调用方在派发时注入）。',
      workspace_id: '证据所属工作区 id（分区键）。',
    },
    boundaries: '只产证据、不产提案、不发 eff；提案用 orchestration.propose。',
    // 两个参数由调用方在派发时注入（模型不知哈希），故声明为可选、不 required。
    argsSchema: {
      type: 'object',
      properties: { user_message_def: {}, workspace_id: { type: 'string' } },
      additionalProperties: true,
    },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
    idempotent: false,
    render: {
      form: 'card',
      label: 'record',
      summary: 'record  {result.evidence_id}',
      tone: 'plain',
      detail: { kind: 'json' },
    },
    ...overrides,
  }
}

/** guard.judge 的 allow 兜底：按 calls 逐项回 allow。 */
export function guardAllow(args) {
  const calls = Array.isArray(args?.calls) ? args.calls : []
  return {
    decisions: calls.map((call, index) => ({
      index,
      port: call.port,
      tool: call.tool,
      verdict: 'allow',
      reason: 'allowed',
    })),
    summary: { allow: calls.length, escalate: 0, deny: 0 },
  }
}

/** guard.judge：按 tool 名映射 verdict（缺省 allow）。 */
export function guardByTool(map) {
  return (args) => {
    const calls = Array.isArray(args?.calls) ? args.calls : []
    return {
      decisions: calls.map((call, index) => ({
        index,
        port: call.port,
        tool: call.tool,
        verdict: map[call.tool] ?? 'allow',
        reason: 'test',
      })),
      summary: { allow: 0, escalate: 0, deny: 0 },
    }
  }
}
