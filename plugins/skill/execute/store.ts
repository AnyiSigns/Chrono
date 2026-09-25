// skill 运行记录（技能清单）的自有持久存储（④ `CHRONO_PLUGIN_DATA`）。
// 引擎 = 单文件追加日志 `skill.jsonl`（每条一次 append + fsync，换行收尾）；启动重放取最后一条 body。
// 每条记录盖回合 id（`run`）：同内容重复写幂等短路；中途崩只留完整前缀（半写行跳过）。
// 存量不搬：存储从空开始；读时把世界遗留 body 作基线合并，但不写回世界。

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
import type { Json, Rec } from './types.ts'

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

/** 技能清单存储。写口只有本身份：每次变更落一条记录；读从内存态返回（启动重放得到）。 */
export class SkillStore {
  private readonly dataFile: string | null
  private current: Rec = {}
  private records = 0

  private constructor(dataFile: string | null) {
    this.dataFile = dataFile
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`；未注入则纯内存（仅测试）。 */
  static open(env: NodeJS.ProcessEnv = process.env): SkillStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    let dataFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'skill.jsonl')
    }
    return new SkillStore(dataFile)
  }

  private apply(record: Rec): void {
    if (record['t'] !== 'body') return
    const body = record['body']
    if (isRecord(body)) this.current = body
  }

  /** 整份已落存储的清单（不含世界遗留基线）。 */
  body(): Rec {
    return this.current
  }

  /** 写入新清单（边跑边追加）；内容未变短路，返回是否落盘。 */
  write(run: string | null, body: Rec): boolean {
    if (canonicalEqual(this.current as Json, body as Json)) return false
    this.records += 1
    this.apply({ t: 'body', run, body })
    appendRecord(this.dataFile, { t: 'body', run, body })
    return true
  }

  /** 已落记录条数（③ 派生，仅供诊断）。 */
  recordCount(): number {
    return this.records
  }
}
