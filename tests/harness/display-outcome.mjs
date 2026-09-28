// UI 收束规则的参照实现（供 e2e 断言）。
// `run.finished` 只表机械终止（done / failed / cancelled / interrupted），不编码业务结局；
// 「机械状态 = done 而回合没有业务结局」是契约违背，不得静默按成功显示。
// 业务结局来自 `chat.turn.settled` 事件 / 命令回执 / session 回合记录三通道，本函数只做机械状态与业务结局的合成。

/** 合成显示结局：done + 无业务结局 = 契约违背；非 done 的机械状态各自成类。 */
export function foldDisplayOutcome(runStatus, businessOutcome) {
  if (runStatus === 'done') {
    if (businessOutcome === null || businessOutcome === undefined) {
      return { kind: 'contract_violation', reason: 'done_without_outcome' }
    }
    return businessOutcome
  }
  if (runStatus === 'failed') return { kind: 'transport_failed' }
  if (runStatus === 'cancelled') return { kind: 'cancelled' }
  if (runStatus === 'interrupted') return { kind: 'interrupted' }
  return businessOutcome ?? { kind: 'unknown' }
}
