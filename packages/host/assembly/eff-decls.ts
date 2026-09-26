// 入世期 eff 声明校验：term AST 里的效果头必须落在插件声明的能力面内。
// 纯机械集合判断，不解释糖化语义、不取值：读 `plugin.json` 的 implements / pins / methods，
// 扫 term 原语结构的 eff 头取 port / method 两个位置。
// 自调用（port ∈ implements）与跨身份（port ∈ pins）口径不同，见 docs/term-toolchain.md §六.1：
// 自调用方法名属本包声明，入世期机械校验；跨身份方法名属被调身份声明，按世界里的被调声明判，
// 被调声明读不出（保留能力 `host` / 尚未入世 / 声明不可解析）时跳过，不新增拒绝语义。

import { isRecord } from '../common/json.ts'
import type { Json } from '../../kernel/index.ts'

/** 校验上下文：本包声明面 + 被调身份声明解析。 */
export interface EffDeclContext {
  implements: ReadonlySet<string>
  /** `pins` 的逻辑端点名（port）集合。 */
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
 */
export function walkEffs(ast: Json, visit: (port: Json, method: Json) => void): void {
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
        return
    }
  }
  walk(ast)
}

/** 校验一个 term AST 的全部 eff 头；返回拒绝理由（空即通过）。 */
export function validateEffDecls(ast: Json, ctx: EffDeclContext): string[] {
  const issues: string[] = []
  walkEffs(ast, (port, method) => {
    if (typeof port !== 'string') {
      issues.push('undeclared_port')
      return
    }
    const selfCall = ctx.implements.has(port)
    if (!selfCall && !ctx.pins.has(port)) {
      issues.push(`undeclared_port:${port}`)
      return
    }
    let declared: string[] | undefined
    if (selfCall) {
      declared = ctx.methods[port]
    } else {
      // 跨身份：被调声明读不出（保留能力 / 尚未入世 / 不可解析）时跳过，不新增拒绝语义。
      const calleeMethods = ctx.calleeMethodsOf(port)
      if (calleeMethods === null) return
      declared = calleeMethods[port]
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
  return issues
}
