// 最小 MCP 测试服务器（不入世界，仅测试用）。
// 以 MCP stdio 传输通信：stdin 读、stdout 写「换行分隔的 JSON-RPC 消息」（每行一条）。
// 模式（--mode=）：
//   ok          静态三工具 echo / add / boom
//   listchanged 首次 tools/list 后发 notifications/tools/list_changed，并多出一个 extra 工具
//   dirty_once  仅在首次 tools/list 后发一次 list_changed（工具集不变）
//   once        处理一次 tools/list 后退出（验证重连）
//   die         启动即退出（验证失败计数 / 隔离阈值）
//   image       echo 带 image 标注（验证 detail.kind 映射）
// --marker=<path> 启动时写、退出时删（验证子进程被终止）。

import { rmSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)

function flag(name) {
  const prefix = `${name}=`
  for (const token of argv) {
    if (token.startsWith(prefix)) return token.slice(prefix.length)
  }
  const index = argv.indexOf(name)
  return index >= 0 ? (argv[index + 1] ?? '') : null
}

const mode = flag('--mode') ?? 'ok'
const marker = flag('--marker')
const envMarker = flag('--env-marker')

if (envMarker !== null) {
  try {
    writeFileSync(envMarker, process.env.ECHO_TOKEN ?? '')
  } catch {
    // 环境标记写失败不影响协议行为
  }
}

if (marker !== null) {
  try {
    writeFileSync(marker, String(process.pid))
  } catch {
    // 标记写失败不影响协议行为
  }
}

function cleanup() {
  if (marker === null) return
  try {
    rmSync(marker, { force: true })
  } catch {
    // 已删除 / 无权限：忽略
  }
}

process.on('exit', cleanup)
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})

if (mode === 'die') {
  cleanup()
  process.exit(1)
}

function toolFor(name) {
  if (name === 'echo') {
    const tool = {
      name: 'echo',
      description: '回显输入文本',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: '要回显的文本' } },
        required: ['message'],
      },
    }
    if (mode === 'image') {
      tool.annotations = { content_type: 'image/png' }
      tool.outputSchema = { type: 'object', format: 'image' }
    }
    return tool
  }
  if (name === 'add') {
    return {
      name: 'add',
      description: '两数相加',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: '加数 a' },
          b: { type: 'number', description: '加数 b' },
        },
        required: ['a', 'b'],
      },
    }
  }
  if (name === 'extra') {
    return { name: 'extra', description: '后加的工具', inputSchema: { type: 'object', properties: {} } }
  }
  if (name === 'bare') {
    return { name: 'bare', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }
  }
  return {
    name: 'boom',
    description: '总是失败的示例工具',
    inputSchema: { type: 'object', properties: {} },
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let listCount = 0

function handle(message) {
  if (message === null || typeof message !== 'object') return
  const id = message.id
  const method = message.method
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-mcp', version: '0.0.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    listCount += 1
    let names = ['echo', 'add', 'boom']
    if (mode === 'minimal') names = ['bare']
    if (mode === 'listchanged') names = listCount === 1 ? ['echo'] : ['echo', 'extra']
    send({ jsonrpc: '2.0', id, result: { tools: names.map(toolFor) } })
    if (mode === 'listchanged' && listCount === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    if (mode === 'dirty_once' && listCount === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    if (mode === 'once') setTimeout(() => process.exit(0), 20)
    return
  }
  if (method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (name === 'boom') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
      return
    }
    if (name === 'add') {
      const sum = Number(args.a ?? 0) + Number(args.b ?? 0)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(sum) }] } })
      return
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(args) }] } })
    return
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_found' } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index < 0) break
    const line = buffer.slice(0, index).replace(/\r$/, '')
    buffer = buffer.slice(index + 1)
    if (line.trim().length === 0) continue
    let message = null
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    handle(message)
  }
})
process.stdin.on('end', () => {
  cleanup()
  process.exit(0)
})
