// 可见性黑名单：钉在包内常量，随代码入世——改它 = 代码换代 = 走人闸。
// 刻意不放进 schema（世界数据）：世界数据可经其它写路径产出 add_gen 直接改，
// 名单住世界数据等于没锁。此表与「受保护 pins 身份表」（宿主侧）是两回事。

/** 对 agent 隐藏的身份：`sandbox`（四档 fs 强制）与自身（`plugin-admin`）。 */
export const HIDDEN_IDENTITIES: readonly string[] = Object.freeze(['sandbox', 'plugin-admin'])

/** 身份是否对 agent 隐藏。 */
export function isHidden(identity: string): boolean {
  return HIDDEN_IDENTITIES.includes(identity)
}
