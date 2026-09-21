// 端口审计：反向 `port.call` 的宿主侧记录，与世界的 EffectAudit 分流——不进世界、不写链、不参与重放。
// 记录前对 args 顶层 `env` 字段的值脱敏（目标服务照收原值）。落点是一个有界内存环形缓冲，
// 可经宿主 options 注入 sink 覆盖；它只作运维取证，不被业务消费。

import type { Json } from '../kernel/index.ts'

/** 一条反向调用端口审计记录：`args` 已脱敏，其余字段是机械路由信息。 */
export interface PortAuditRecord {
  at: number
  /** 发起服务所属身份（`port.call` 的发出者）。 */
  from: string
  /** 路由解析出的目标身份；未解析的反向调用不产生记录。 */
  target: string
  port: string
  method: string
  args: Json
  run: string | null
  thread: string | null
}

/** 端口审计落点：缺省写宿主侧环形缓冲；宿主 options 可注入自定义 sink（测试 / 观测）。 */
export interface PortAuditSink {
  record(record: PortAuditRecord): void
}

/** 缺省环形缓冲容量：端口审计只作运维取证、不参与业务，故有界。 */
export const PORT_AUDIT_CAPACITY = 256

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 脱敏 args 顶层 `env` 字段的值：替换为 `{redacted:true, keys:[…键名]}`（键名排序、确定性）；
 * `env` 缺席时原样返回，其余字段一律原样（浅拷贝）。非对象 `env` 也整体替换，避免值外泄。
 */
export function redactPortArgs(args: Json): Json {
  if (!isRecord(args) || !Object.hasOwn(args, 'env')) return args
  const env = args['env']
  const keys = isRecord(env) ? Object.keys(env).sort() : []
  return { ...args, env: { redacted: true, keys } }
}

/** 有界环形缓冲：满即覆盖最旧记录；`records()` 返回按时间正序的快照副本（只读）。 */
export class PortAuditRing implements PortAuditSink {
  private readonly capacity: number
  private readonly buffer: PortAuditRecord[] = []

  constructor(capacity: number = PORT_AUDIT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`bad_port_audit_capacity: ${capacity}`)
    }
    this.capacity = capacity
  }

  record(record: PortAuditRecord): void {
    if (this.buffer.length >= this.capacity) this.buffer.shift()
    this.buffer.push(record)
  }

  records(): PortAuditRecord[] {
    return [...this.buffer]
  }
}
