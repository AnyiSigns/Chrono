// 声明非法运维日志去重：同一身份只在「非法集合签名」变化时重记。
// 声明修好（该身份不再非法）后签名清除，故再次变坏会重新记录——不能只按 (身份, 原因) 永久去重。

export interface InvalidDecl {
  identity: string
  reason: string
}

/**
 * 有状态去重器：`report` 每次传入当前世界读到的全部非法条目。
 * 同一身份的原因集合（排序后）未变则不重复写；身份从非法变合法时清除签名。
 */
export class InvalidDeclLog {
  private readonly lastSignature = new Map<string, string>()
  private readonly write: (identity: string, reason: string) => void

  constructor(write: (identity: string, reason: string) => void) {
    this.write = write
  }

  report(items: readonly InvalidDecl[]): void {
    const byIdentity = new Map<string, string[]>()
    for (const item of items) {
      const reasons = byIdentity.get(item.identity)
      if (reasons === undefined) byIdentity.set(item.identity, [item.reason])
      else reasons.push(item.reason)
    }
    for (const [identity, reasons] of byIdentity) {
      const signature = [...reasons].sort().join('\u0000')
      if (this.lastSignature.get(identity) === signature) continue
      this.lastSignature.set(identity, signature)
      for (const reason of reasons) this.write(identity, reason)
    }
    for (const identity of [...this.lastSignature.keys()]) {
      if (!byIdentity.has(identity)) this.lastSignature.delete(identity)
    }
  }
}
