// 平台判定唯一出口：`process.platform` 分支只允许出现在平台适配层，其余模块一律经本文件判定。

/** 当前是否运行在 Windows：命名管道、junction、`taskkill` 等分支的唯一判据。 */
export function isWindows(): boolean {
  return process.platform === 'win32'
}
