// 工具结果摘要（digest）：随成功结果自带，供上下文老化直接渲染，无需装配器认识工具语义。
// 只放确定、有界的展示字段：动作名 + 该动作可用的落点 / 状态 / 字节数；不含时间、不含正文全文。

import type { Json, Rec } from './types.ts'

/** UTF-8 字节数（信息性规模字段，不参与上限判断）。 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 浏览器动作摘要：动作名 + 附加展示字段（如 navigate 的 url/status、screenshot 的 bytes）。 */
export function actionDigest(action: string, extra: Rec = {}): Rec {
  return { action, ...extra }
}
