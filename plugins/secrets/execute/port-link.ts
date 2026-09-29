// 多后端注册表：密钥后端扩展类 `secrets-backend` 的世界成员表（宿主按世界能力索引注入）
// 由本模块持有。按 `auth_ref.kind` 在成员间定位（字典序注入序首命中；同 kind 多命中即歧义报错），
// 再经反向 `port.call secrets-backend.read / list / kinds`（帧带 `provider` 成员身份）委派。
// 加 / 减一个后端 = 世界成员表变化，本模块代码零改动（不枚举后端）。
// 失败作数据（结构化码），不抛未捕获错误、不断通道。

import { isRecord } from 'plugin-sdk'
import type { Json, PortCaller } from 'plugin-sdk'

/** 密钥后端扩展类（拥有方 `secrets` 的 `slots` 契约）：成员由宿主注入的 `many` 成员表给出。 */
export const SECRETS_BACKEND = 'secrets-backend'

/**
 * 路由 / 传输层失败码（宿主路由解析或通道故障，非后端数据面错误）：
 * 该成员视作元素错误跳过，不影响其它成员（提供方出问题只隔离提供方）。
 */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'unresolved_cap',
  'stale',
  'not_loaded',
  'transport_failed',
  'internal',
])

/** 后端结构化失败：带协议码，调用方据此回结构化错误。 */
export class BackendError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/**
 * 密钥后端注册表：按世界成员表定位 kind 的提供方，并反调其 `read` / `list`。
 * 成员按注入序（宿主的码元序）遍历，选择结果确定。
 */
export class SecretBackends {
  private readonly link: PortCaller
  private readonly members: readonly string[]
  private readonly kindsCache = new Map<string, string[]>()

  constructor(link: PortCaller, members: readonly string[]) {
    this.link = link
    this.members = members
  }

  /** 成员自述的 kind 集（按成员缓存：成员集随世代注入，服务实例生命周期内不变）。 */
  private async kindsOf(provider: string): Promise<string[]> {
    const cached = this.kindsCache.get(provider)
    if (cached !== undefined) return cached
    const outcome = await this.link.call(SECRETS_BACKEND, 'kinds', {}, { provider })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    const value = outcome.value
    const kinds = Array.isArray(value)
      ? value.filter((kind): kind is string => typeof kind === 'string' && kind.length > 0)
      : []
    this.kindsCache.set(provider, kinds)
    return kinds
  }

  /**
   * 按 kind 定位成员：成员按注入序逐个查 `kinds`，收集声明该 kind 者。
   * 恰好一个 → 返回该成员身份名；无 → `secret_kind_unsupported`；多个 → `secret_kind_ambiguous`。
   * 不可达成员按元素错误跳过：一个后端故障不影响其它 kind 的解析（提供方出问题只隔离提供方）。
   */
  async select(kind: string): Promise<string> {
    const hits: string[] = []
    let unavailable = false
    for (const provider of this.members) {
      let kinds: string[]
      try {
        kinds = await this.kindsOf(provider)
      } catch {
        unavailable = true
        continue
      }
      if (kinds.includes(kind)) hits.push(provider)
    }
    const [first] = hits
    if (first === undefined) {
      if (unavailable) {
        throw new BackendError(
          'secret_unreadable',
          `a secret backend is unavailable while resolving kind: ${kind}`,
        )
      }
      throw new BackendError('secret_kind_unsupported', `no secret backend serves kind: ${kind}`)
    }
    if (hits.length > 1) {
      throw new BackendError(
        'secret_kind_ambiguous',
        `multiple secret backends serve kind: ${kind}`,
      )
    }
    return first
  }

  /** 解析一条引用：定位成员后反调其 `read`；返回明文（仅存调用方内存）。 */
  async read(kind: string, name: string): Promise<string> {
    const provider = await this.select(kind)
    const outcome = await this.link.call(SECRETS_BACKEND, 'read', { name }, { provider })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (typeof outcome.value !== 'string') {
      throw new BackendError('secret_missing', `${provider}.read returned no value`)
    }
    return outcome.value
  }

  /**
   * 汇总全部成员的 `list`（只回 `{name,has}`）：按名去重、字典序排序，保确定性。
   * 不可达成员按元素错误跳过（只隔离提供方）；可达成员的数据面错误（如文件不可读）原样上抛，
   * 保住 `secrets.list` 既有的失败契约。
   */
  async list(): Promise<Json> {
    const byName = new Map<string, Json>()
    for (const provider of this.members) {
      const outcome = await this.link.call(SECRETS_BACKEND, 'list', {}, { provider })
      if (!outcome.ok) {
        if (TRANSPORT_CODES.has(outcome.code)) continue
        throw new BackendError(outcome.code, outcome.message)
      }
      const entries = Array.isArray(outcome.value) ? outcome.value : []
      for (const entry of entries) {
        if (!isRecord(entry)) continue
        const name = entry['name']
        if (typeof name !== 'string' || name.length === 0) continue
        byName.set(name, entry)
      }
    }
    return [...byName.keys()].sort().map((name) => byName.get(name) as Json)
  }
}
