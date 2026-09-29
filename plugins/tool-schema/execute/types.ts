// 服务内部共享类型：JSON 面与形态判定由 plugin-sdk 提供；
// 本模块只做转发，供 schema-validate 与其它文件同源取用。

export { isRecord } from 'plugin-sdk'
export type { Json, Rec } from 'plugin-sdk'
