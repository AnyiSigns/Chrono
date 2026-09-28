// 生成物漂移检查：逐份比对插件内 execute/contract/index.ts 与源派生结果。
// 独立可运行：node chain-contract/tools/check-drift.mjs；有漂移即退出码 1 并逐份点名。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACT_DIR, SOURCE_HASH, TARGETS, generateAll } from './generate.mjs'

const HEADER_HASH = /source-sha256=([0-9a-f]{64})/

const expected = generateAll()
const failures = []

for (const target of TARGETS) {
  const absolute = join(CONTRACT_DIR, '..', target)
  if (!existsSync(absolute)) {
    failures.push(`${target}: missing generated copy`)
    continue
  }
  const actual = readFileSync(absolute, 'utf8')
  const want = expected.get(target)
  if (actual !== want) {
    const match = HEADER_HASH.exec(actual)
    const embedded = match === null ? 'none' : match[1]
    const reason = embedded === SOURCE_HASH ? 'body edited by hand' : `stale source hash (${embedded})`
    failures.push(`${target}: drift detected (${reason})`)
    continue
  }
  const match = HEADER_HASH.exec(actual)
  if (match === null || match[1] !== SOURCE_HASH) {
    failures.push(`${target}: generated header missing/incorrect source hash`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`contract drift check failed (${failures.length}):\n`)
  for (const failure of failures) process.stderr.write(`  ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `contract drift check passed: ${TARGETS.length} copies match source-sha256 ${SOURCE_HASH}\n`,
  )
}
