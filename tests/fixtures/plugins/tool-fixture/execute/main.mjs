// `tool-fixture`：最小工具提供方（自注册 `implements:["tool-provider"]`）。
// 证明「加一个工具插件 = 新插件自注册，工具链代码零改动」：本服务只回一个合法工具声明；
// 目录由 `tool-registry` 按世界成员表逐个反向 `describe` 装配，无需任何枢纽枚举。
// 自实现最小服务协议帧循环（不依赖 plugin-sdk / 无第三方依赖），便于测试直接 spawn。

const PROTOCOL = '1'
const IDENTITY = 'tool-fixture'

/** 一个合法工具声明（四要素齐备、argsSchema 白名单子集、caps 对象形）。 */
const TOOL = {
  name: 'fixture.echo',
  intent: '回显调用方给出的文本。',
  when_to_use: '需要验证工具目录与派发链路时。',
  param_semantics: { text: '要回显的文本。' },
  boundaries: '只回显、无副作用。',
  description: '回显文本。',
  argsSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
  idempotent: true,
  render: { form: 'line', label: 'fixture', summary: '{text}' },
}

function manifest() {
  return {
    v: PROTOCOL,
    identity: IDENTITY,
    implements: ['tool-provider'],
    methods: { 'tool-provider': ['describe', 'invoke'] },
    protocol: PROTOCOL,
    state: 'recomputable',
  }
}

function handle(message, emit) {
  if (message === null || typeof message !== 'object') return
  switch (message.kind) {
    case 'hello':
      emit({ id: message.id, kind: 'manifest', ...manifest() })
      return
    case 'probe':
      emit({ v: PROTOCOL, id: message.id, kind: 'pong', ok: true })
      return
    case 'reload':
      emit({ v: PROTOCOL, id: message.id, kind: 'ack' })
      return
    case 'drain':
      emit({ v: PROTOCOL, id: message.id, kind: 'bye' })
      return
    case 'call':
      if (message.port !== 'tool-provider') {
        emit({
          v: PROTOCOL,
          id: message.id,
          kind: 'error',
          ok: false,
          code: 'unresolved_cap',
          message: `unknown capability ${String(message.port)}`,
        })
        return
      }
      if (message.method === 'describe') {
        emit({ v: PROTOCOL, id: message.id, kind: 'result', ok: true, value: { tools: [TOOL] } })
        return
      }
      if (message.method === 'invoke') {
        const args = message.args && typeof message.args === 'object' ? message.args : {}
        emit({
          v: PROTOCOL,
          id: message.id,
          kind: 'result',
          ok: true,
          value: { ok: true, result: { echoed: args.args ?? null } },
        })
        return
      }
      emit({
        v: PROTOCOL,
        id: message.id,
        kind: 'error',
        ok: false,
        code: 'unknown_method',
        message: `unknown method ${String(message.method)}`,
      })
      return
    default:
      return
  }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

const emit = (message) => frame(message)
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0)
    if (buffer.length < 4 + length) break
    const body = buffer.subarray(4, 4 + length).toString('utf8')
    buffer = buffer.subarray(4 + length)
    try {
      handle(JSON.parse(body), emit)
    } catch {
      // 坏帧忽略
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
process.stderr.write(`[tool-fixture] started\n`)
