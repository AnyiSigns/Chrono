// 超时嵌套静态一致性：各层 `method_timeouts` 的安全网必须严格大于其直接包裹的内层；对在一个调用内
// 顺序跑多个内层的方法，外层须大于这些内层上限之和，而非仅超过其中单个——否则外层先到期、内层还没
// 机会自收口（长回合因此永远跑不完）。反向调用等待上限须落在「被调用层」与「属主层安全网」之间，
// 使慢内层以自身错误收口、不被外层掐断。读各插件 schema / 服务入口声明比对，是声明层防漂移检查：
// 任何人改小外层或改大内层都会让此测试失败。
// 分段执行后一次 `interpret` 恒为一段（一个 iter），外层安全网只兜一段；整回合长度由预算阶梯与宿主
// 轮数上限兜底，不再由单次超时放大覆盖，另有一项显式钉住该分段关系。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readJson = (rel) => JSON.parse(readFileSync(join(PLUGINS, rel), 'utf8'))
const readText = (rel) => readFileSync(join(PLUGINS, rel), 'utf8')

// 韧性缺省（含 socket 空闲超时 request_timeout_ms）的单一真源在 throttle；model-protocol 只声明方法超时。
const THROTTLE = readJson('throttle/schema/throttle.json')
const SOCKET_IDLE_MS = THROTTLE.resilience.request_timeout_ms
const MODEL_TIMEOUTS = readJson('model-protocol/schema/protocol.json').method_timeouts
const CHAT_TIMEOUTS = readJson('chat/schema/wiring.json').method_timeouts
const LOOP_TIMEOUTS = readJson('loop-policy/schema/graph.json').method_timeouts
const TOOLS_TIMEOUTS = readJson('tools/schema/tools.json').method_timeouts
const CONTEXT_TIMEOUTS = readJson('context-window/schema/policy.json').method_timeouts
const SESSION_TIMEOUTS = readJson('session/schema/session.json').method_timeouts

const MAX_TIMER_MS = 2 ** 31 - 1

/** 从服务入口读反向调用等待上限常量（`PORT_CALL_TIMEOUT_MS`）。 */
function reverseCap(rel) {
  const match = readText(rel).match(/PORT_CALL_TIMEOUT_MS\s*=\s*(\d+)/)
  assert.ok(match !== null, `${rel} 未找到 PORT_CALL_TIMEOUT_MS`)
  return Number(match[1])
}

test('method_timeouts 值域：正整数且不超过计时器硬上限', () => {
  for (const [scope, table] of [
    ['chat', CHAT_TIMEOUTS],
    ['loop-policy', LOOP_TIMEOUTS],
    ['model-protocol', MODEL_TIMEOUTS],
    ['tools', TOOLS_TIMEOUTS],
    ['context-window', CONTEXT_TIMEOUTS],
    ['session', SESSION_TIMEOUTS],
  ]) {
    for (const [key, value] of Object.entries(table)) {
      assert.equal(Number.isInteger(value) && value > 0, true, `${scope} 的 ${key} 必须是正整数`)
      assert.equal(value <= MAX_TIMER_MS, true, `${scope} 的 ${key} 不得超过计时器硬上限`)
    }
  }
})

test('socket 空闲超时是最内层判活机制，不是总时长上限', () => {
  assert.equal(SOCKET_IDLE_MS > 0 && SOCKET_IDLE_MS < MODEL_TIMEOUTS['model.chat'], true)
})

test('外层安全网严格大于其直接包裹的内层', () => {
  const chatSend = CHAT_TIMEOUTS['chat.send']
  const chatResume = CHAT_TIMEOUTS['chat.resume']
  const interpret = LOOP_TIMEOUTS['loop-policy.interpret']
  const modelChat = MODEL_TIMEOUTS['model.chat']
  const modelComplete = MODEL_TIMEOUTS['model.complete']
  const toolsDispatch = TOOLS_TIMEOUTS['tools.dispatch']

  assert.ok(chatSend > interpret, 'chat.send 必须大于 loop-policy.interpret')
  assert.ok(chatResume > interpret, 'chat.resume 必须大于 loop-policy.interpret')
  assert.ok(interpret > modelChat, 'loop-policy.interpret 必须大于 model.chat')
  assert.ok(interpret > modelComplete, 'loop-policy.interpret 必须大于 model.complete')
  assert.ok(interpret > toolsDispatch, 'loop-policy.interpret 必须大于 tools.dispatch')
  assert.ok(modelChat > SOCKET_IDLE_MS, 'model.chat 必须大于 socket 空闲超时')
})

test('外层安全网严格大于一个调用内顺序内层之和', () => {
  // 一段 interpret 在一个调用内顺序跑 context.build → model.chat → guard → tools.dispatch → session 写，
  // 故外层须超过 model.chat + tools.dispatch 之和，而非仅仅超过其中单个。
  const interpret = LOOP_TIMEOUTS['loop-policy.interpret']
  assert.ok(
    interpret > MODEL_TIMEOUTS['model.chat'] + TOOLS_TIMEOUTS['tools.dispatch'],
    'loop-policy.interpret 必须大于 model.chat + tools.dispatch 之和',
  )
})

test('分段执行后：一次 interpret = 一段（一个 iter），整回合由预算与轮数上限兜底', () => {
  // 分段落地后 `interpretGraph` 一次调用只跑一个 iter（段内顺序跑 context.build → model.chat →
  // tools.dispatch 等），外层安全网只兜这一段，不再被 max_turn_iter 倍放大。整回合的上限改由预算阶梯
  // （max_turn_iter / max_steps）与宿主轮数上限约束，长回合不再靠单次超时覆盖。
  const bound = Number(readText('loop-policy/execute/seed.ts').match(/max_turn_iter:\s*(\d+)/)?.[1] ?? Number.NaN)
  assert.ok(Number.isInteger(bound) && bound > 1, '未找到 max_turn_iter 阈值')
  const perIter = MODEL_TIMEOUTS['model.chat'] + TOOLS_TIMEOUTS['tools.dispatch']
  // 一段的同步内层之和须装进本层安全网（一段不再等于整回合）。
  assert.ok(LOOP_TIMEOUTS['loop-policy.interpret'] > perIter, '一次 interpret 必须兜住一段的内层之和')
  // 预算允许的整回合规模远大于单段安全网 ⇒ 整回合不再由单次超时兜底，而由预算 / 轮数上限先收口。
  assert.ok(
    bound * perIter > LOOP_TIMEOUTS['loop-policy.interpret'],
    '整回合由预算 / 轮数上限兜底：预算允许的规模应超过单段安全网',
  )
})

test('反向调用等待上限落在被调用层与属主层安全网之间', () => {
  // loop-policy 的反向调用打到 model.chat，其属主层是 loop-policy.interpret。
  const loopCap = reverseCap('loop-policy/execute/main.ts')
  assert.ok(loopCap > MODEL_TIMEOUTS['model.chat'], 'loop-policy 反向上限必须大于 model.chat')
  assert.ok(loopCap < LOOP_TIMEOUTS['loop-policy.interpret'], 'loop-policy 反向上限必须小于 loop-policy.interpret')

  // chat 的反向调用打到 loop-policy.interpret，其属主层是 chat.send。
  const chatCap = reverseCap('chat/execute/main.ts')
  assert.ok(chatCap > LOOP_TIMEOUTS['loop-policy.interpret'], 'chat 反向上限必须大于 loop-policy.interpret')
  assert.ok(chatCap < CHAT_TIMEOUTS['chat.send'], 'chat 反向上限必须小于 chat.send')
})

test('取消链的外层大于其顺序内层之和', () => {
  // chat.cancel 在一个调用内顺序反向调用 session.turn_cancel → loop-policy.cancel → model-protocol.abort
  // → session.turn_settle，故其安全网须大于这些内层声明超时之和，否则外层先到期、取消链还没走完。
  const sessionCeiling = Math.max(SESSION_TIMEOUTS['session.turn_cancel'], SESSION_TIMEOUTS['session.turn_settle'])
  assert.ok(
    CHAT_TIMEOUTS['chat.cancel'] > sessionCeiling + LOOP_TIMEOUTS['loop-policy.cancel'] + MODEL_TIMEOUTS['model.abort'],
    'chat.cancel 必须大于其顺序内层声明超时之和',
  )
  assert.ok(LOOP_TIMEOUTS['loop-policy.cancel'] > 0, 'loop-policy.cancel 须声明超时')
  assert.ok(MODEL_TIMEOUTS['model.abort'] > 0, 'model.abort 须声明超时')
})

test('安全网值与约定一致（不得缩小）', () => {
  assert.equal(CHAT_TIMEOUTS['chat.send'], 6300000)
  assert.equal(CHAT_TIMEOUTS['chat.resume'], 6300000)
  assert.equal(CHAT_TIMEOUTS['chat.cancel'], 600000)
  assert.equal(LOOP_TIMEOUTS['loop-policy.interpret'], 6000000)
  assert.equal(LOOP_TIMEOUTS['loop-policy.cancel'], 30000)
  assert.equal(MODEL_TIMEOUTS['model.chat'], 3600000)
  assert.equal(MODEL_TIMEOUTS['model.complete'], 3600000)
  assert.equal(MODEL_TIMEOUTS['model.abort'], 30000)
  assert.equal(SESSION_TIMEOUTS['session.turn_cancel'], 120000)
  assert.equal(TOOLS_TIMEOUTS['tools.dispatch'], 1800000)
  assert.equal(reverseCap('chat/execute/main.ts'), 6150000)
  assert.equal(reverseCap('loop-policy/execute/main.ts'), 4200000)
  // 本地 fs / CPU 层（属主在别处声明），只核验已按表声明，不改它。
  assert.equal(CONTEXT_TIMEOUTS['context.build'], 120000)
})
