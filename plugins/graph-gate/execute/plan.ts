// 机械闸共享纯函数真源在 `plugin-sdk`（形态判定与 def 引用解析；纯函数，无副作用）。
// 本文件保留为同名 re-export 面，供既有直接 import 解析。

export {
  HASH_RE,
  asArray,
  asString,
  asStringArray,
  defHashOf,
  isRecord,
  numberField,
} from 'plugin-sdk'
