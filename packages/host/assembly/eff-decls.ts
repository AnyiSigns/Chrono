// 入世期 eff 声明校验：term AST 里的效果头必须落在插件声明的能力面内。
// 纯机械集合判断，不解释糖化语义、不取值：读 `plugin.json` 的 implements / pins / needs / methods，
// 扫 term 原语结构的 eff 头取 port / method 两个位置。
// 自调用与跨身份口径不同，见 docs/term-toolchain.md §六.1：判定优先级与运行期路由同口径——
// 显式 pin（含 `needs` 键）优先于自能力，故 `port ∈ pins` 时一律按跨身份判（即便同键也在 implements）；
// 自调用（仅 implements）方法名属本包声明，入世期机械校验；跨身份方法名属被调身份声明，按世界里的
// 被调声明判，被调声明读不出（保留能力 `host` / 尚未入世 / 声明不可解析）时跳过，不新增拒绝语义。

import { isRecord } from '../common/json.ts'
import { TERM_TAGS } from '../../kernel/index.ts'
import type { Json } from '../../kernel/index.ts'

/** 校验上下文：本包声明面 + 被调身份声明解析。 */
export interface EffDeclContext {
  implements: ReadonlySet<string>
  /** 本包声明消费的逻辑端点名（port）集合：显式 `pins` 键 ∪ `needs` 键。 */
  pins: ReadonlySet<string>
  /** 自调用方法表：能力类 → 方法名。 */
  methods: Record<string, string[]>
  /**
   * 按 pin 的逻辑端点名解析被调身份的 `methods` 映射；返回 null = 看不到被调声明，
   * 跳过跨身份方法名校验（不新增拒绝语义）。
   */
  calleeMethodsOf: (port: string) => Record<string, string[]> | null
}

/**
 * 按 14 原语结构遍历 term AST，对每个 `["eff", port, method, args]` 回调。
 * 只下钻原语的 term 位置；`c` / `g` / `v` 的载荷是字面量数据，不再下钻——
 * 否则 `["c", ["eff", ...]]` 这类字面量会被误判为效果节点。
 * 返回遍历中遇到的、属于内核 `TERM_TAGS` 而本表未覆盖的头（去重；空数组 = 全覆盖）。
 * 内核新增原语而本表未同步时绝不静默跳过（否则新原语内嵌的 eff 会绕过入世门禁），
 * 交调用方整包拒；非内核头（无效 term）由内核在运行期按 `bad_term` 拒，不在本层拦。
 */
export function walkEffs(ast: Json, visit: (port: Json, method: Json) => void): string[] {
  const unknown = new Set<string>()
  const walk = (node: Json): void => {
    if (!Array.isArray(node)) return
    switch (node[0]) {
      case 'c':
      case 'g':
      case 'v':
        return
      case 'get':
        walk(node[1])
        return
      case 'getOr':
        walk(node[1])
        walk(node[3])
        return
      case 'cmp':
        walk(node[1])
        walk(node[2])
        return
      case 'pred':
      case 'arith':
        walk(node[2])
        walk(node[3])
        return
      case 'if':
        walk(node[1])
        walk(node[2])
        walk(node[3])
        return
      case 'fold':
        walk(node[1])
        walk(node[2])
        walk(node[3])
        return
      case 'eff':
        visit(node[1], node[2])
        walk(node[3])
        return
      case 'call':
        walk(node[1])
        if (Array.isArray(node[2])) for (const arg of node[2]) walk(arg)
        return
      case 'list':
        if (Array.isArray(node[1])) for (const item of node[1]) walk(item)
        return
      case 'obj':
        if (isRecord(node[1])) for (const key of Object.keys(node[1])) walk(node[1][key])
        return
      default:
        // 头是内核原语却无本表分支 = 两边名单漂移；记录以便整包拒，绝不静默返回。
        if (typeof node[0] === 'string' && TERM_TAGS.has(node[0])) unknown.add(node[0])
        return
    }
  }
  walk(ast)
  return [...unknown]
}

/**
 * 校验一个 term AST 的全部 eff 头；返回拒绝理由（空即通过）。
 * 未覆盖的 term 头（内核新增原语未同步本表）报 `bad_term:<头>`，整包拒，不静默放行。
 */
export function validateEffDecls(ast: Json, ctx: EffDeclContext): string[] {
  const issues: string[] = []
  const unknown = walkEffs(ast, (port, method) => {
    if (typeof port !== 'string') {
      issues.push('undeclared_port')
      return
    }
    // 跨身份优先：`pins`（显式 pin ∪ needs 键）命中即按被调声明判——与运行期路由
    // 「显式 pin > needs > 自能力」同口径，避免同键既 implements 又 pins 时门禁按自身 methods 判、
    // 路由却走被依赖者（合法调用被拒 / 非法调用放行到运行期）。
    const crossCall = ctx.pins.has(port)
    if (!crossCall && !ctx.implements.has(port)) {
      issues.push(`undeclared_port:${port}`)
      return
    }
    let declared: string[] | undefined
    if (crossCall) {
      // 跨身份：被调声明读不出（保留能力 / 尚未入世 / 不可解析）时跳过，不新增拒绝语义。
      const calleeMethods = ctx.calleeMethodsOf(port)
      if (calleeMethods === null) return
      declared = calleeMethods[port]
    } else {
      declared = ctx.methods[port]
    }
    if (declared === undefined) {
      issues.push(`undeclared_method:${port}`)
      return
    }
    if (typeof method !== 'string' || !declared.includes(method)) {
      issues.push(
        typeof method === 'string'
          ? `undeclared_method:${port}.${method}`
          : `undeclared_method:${port}`,
      )
    }
  })
  for (const tag of unknown) issues.push(`bad_term:${tag}`)
  return issues
}
