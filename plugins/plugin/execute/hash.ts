// 内容哈希与规范序列化真源在 `plugin-sdk`（本包不 import 内核）：
// H = sha256(utf8(canonicalJson(v)))，键升序、剔 undefined、-0→0，同输入同输出、可对拍。
// 候选树的 blob / tree / commit 哈希必须与宿主入世逐字节一致，故此处与内核口径同源。
// 本文件保留为同名 re-export 面，供既有直接 import 解析。

export { H, canonicalJson } from 'plugin-sdk'
