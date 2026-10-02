// 计划构造与共享纯函数真源在 `plugin-sdk`：只把各段返回的写计划机械合并为顶层 `$directives`，
// 不落账、不读投影。本文件保留为同名 re-export 面，供既有直接 import 解析。

export {
  HASH_RE,
  asString,
  defHashOf,
  directivesOf,
  errorValue,
  externDirective,
  externOnly,
  hasDirectives,
  isErrorValue,
  isRecord,
  mergeDirectives,
  numberField,
  positiveInt,
} from 'plugin-sdk'
