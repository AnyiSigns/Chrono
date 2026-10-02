// 厂商身份别名与候选名归一：把本仓身份名（sdk / vendor-* / 显示名）与 models.dev provider 键名对齐。
// 个别身份名与 models.dev 键名不一致的映射集中此处，避免各匹配路径各写一份。

/** 身份名 → models.dev provider 键名的固定别名。 */
export const PROVIDER_ALIASES: Record<string, string> = {
  'google-genai': 'google',
  dashscope: 'alibaba',
}

/** 去掉身份名的 `vendor-` 前缀。 */
export function stripVendorPrefix(name: string): string {
  return name.replace(/^vendor-/, '')
}

/** 候选身份名：原名的去前缀形态，以及两者各自的已知别名（保序、去重）。 */
export function providerCandidates(...names: Array<string | undefined>): Set<string> {
  const out = new Set<string>()
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue
    out.add(name)
    out.add(stripVendorPrefix(name))
  }
  for (const candidate of [...out]) {
    const alias = PROVIDER_ALIASES[candidate]
    if (alias !== undefined) out.add(alias)
  }
  return out
}
