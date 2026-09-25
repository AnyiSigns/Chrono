// MCP 清单（服务器配置 + 发现到的外部工具）的运行记录存储（④ `CHRONO_PLUGIN_DATA`）。
// 清单已出世界：单文件追加日志 `mcp.jsonl`，每条 `{t:'body', run, body}`；启动重放取最后一条 body。
// 每条记录盖回合 id（`run`）：同内容重复写幂等短路（内容比较），中途崩只留完整前缀（半写行跳过）。
// 存量不搬：存储从空开始，旧世界世代留在链上但不再被读。

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalEqual, isRecord } from './plan.ts'
import type { Rec } from './types.ts'

/** 空清单：无服务器、无工具。 */
export function emptyBody(): Rec {
  return { version: 1, servers: [], tools: [] }
}

function appendRecord(path: string | null, record: Rec): void {
  if (path === null) return
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
  const fd = openSync(path, 'a')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function replay(path: string): Rec[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const out: Rec[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (isRecord(parsed)) out.push(parsed)
    } catch {
      // 半写撕裂的末行 / 坏行跳过（fail-open）：已确认前缀照常可用。
    }
  }
  return out
}

/** 清单存储。写口只有本身份：每次 discover 落一条记录；读从内存态返回（启动重放得到）。 */
export class McpStore {
  private readonly dataFile: string | null
  private body: Rec = emptyBody()
  private records = 0

  private constructor(dataFile: string | null) {
    this.dataFile = dataFile
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`。 */
  static open(env: NodeJS.ProcessEnv = process.env): McpStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    let dataFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'mcp.jsonl')
    }
    return new McpStore(dataFile)
  }

  private apply(record: Rec): void {
    if (record['t'] !== 'body') return
    const body = record['body']
    if (isRecord(body)) this.body = body
  }

  /** 整份清单（服务器配置 + 工具）。 */
  read(): Rec {
    return this.body
  }

  /** 写入新清单（边跑边追加）；内容未变短路，返回是否落盘。 */
  write(run: string | null, body: Rec): boolean {
    if (canonicalEqual(this.body, body)) return false
    this.records += 1
    this.apply({ t: 'body', run, body })
    appendRecord(this.dataFile, { t: 'body', run, body })
    return true
  }

  /** 已落记录条数（③ 可重算派生，仅供诊断）。 */
  recordCount(): number {
    return this.records
  }
}
