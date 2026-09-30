// config 运行记录（用户配置 / 界面配置）的自有持久存储（④ `CHRONO_PLUGIN_DATA`）。
// 引擎 = 整份 body 的原子快照 `config.json`（temp → fsync → rename 整份重写）：单例配置不写日志。
// 同内容重复写幂等短路；半写安全由原子替换保证；旧 `config.jsonl` 仅首次启动迁移一次（幂等）。
// 存量不搬：存储从空开始；读时把世界遗留 body 作为基线合并，但不再写回世界（除阈值镜像）。

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalEqual, isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 写满整段：`writeSync` 可能短写，逐段续写直到写完；零进展（返回 <= 0）即抛，与宿主同口径。 */
function writeAllSync(fd: number, data: string): void {
  const buffer = Buffer.from(data, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) throw new Error('short_write')
    offset += written
  }
}

/**
 * 整份原子替换：temp → fsync → rename，读方永不看到半写 JSON。
 * 插件不 import 宿主，按宿主 `common/fs-atomic` 同口径本地实现；失败清理临时文件。
 */
function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'w')
    writeAllSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 已关闭
      }
    }
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件清理失败不掩盖原错
    }
    throw err
  }
}

/** 读新格式快照：缺文件 / 非对象 / 坏 JSON 视为无。 */
function readSnapshot(path: string): Rec | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 读旧追加日志的最后一条 `{t:'body', body}`（半写撕裂 / 坏行跳过，fail-open）；无则 null。 */
function readLegacyBody(path: string): Rec | null {
  if (!existsSync(path)) return null
  let last: Rec | null = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (isRecord(parsed) && parsed['t'] === 'body' && isRecord(parsed['body'])) last = parsed['body']
    } catch {
      // 半写撕裂的末行 / 坏行跳过（fail-open）。
    }
  }
  return last
}

/** 配置存储。写口只有本身份：每次变更整份原子重写快照；读从内存态返回（启动载入得到）。 */
export class ConfigStore {
  private readonly dataFile: string | null
  private current: Rec = {}
  private records = 0

  private constructor(dataFile: string | null, legacyFile: string | null) {
    this.dataFile = dataFile
    if (dataFile === null) return
    const snapshot = readSnapshot(dataFile)
    if (snapshot !== null) {
      this.current = snapshot
      this.records = 1
      return
    }
    // 首次启动若只有旧 `config.jsonl`：取最后一条 body 作初值并以新格式落盘（幂等；失败留旧文件重试）。
    if (legacyFile !== null) {
      const legacy = readLegacyBody(legacyFile)
      if (legacy !== null) {
        this.current = legacy
        this.records = 1
        try {
          writeFileAtomic(dataFile, JSON.stringify(legacy))
        } catch {
          // 迁移落盘失败：内存初值仍可用，下次启动重试。
        }
      }
    }
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`；未注入则纯内存（仅测试）。 */
  static open(env: NodeJS.ProcessEnv = process.env): ConfigStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    let dataFile: string | null = null
    let legacyFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'config.json')
      legacyFile = join(dataDir, 'config.jsonl')
    }
    return new ConfigStore(dataFile, legacyFile)
  }

  /** 整份已落存储的配置（不含世界遗留基线）。 */
  body(): Rec {
    return this.current
  }

  /** 整份原子重写快照；内容未变短路，返回是否落盘。 */
  write(_run: string | null, body: Rec): boolean {
    if (canonicalEqual(this.current as Json, body as Json)) return false
    if (this.dataFile !== null) writeFileAtomic(this.dataFile, JSON.stringify(body))
    this.current = body
    this.records += 1
    return true
  }

  /** 已落记录条数（③ 派生，仅供诊断）。 */
  recordCount(): number {
    return this.records
  }
}
