// 输入槽写指令（纯函数，零 react / DOM）：读-改-写本线程槽。
// 有数据世代（`dataGen.seq`）且本线程槽确有变化 ⇒ 写 `replace ["slots", <thread>]` 补丁世代 + `base`；
// 否则整份 `put` + `add_gen`。`expectActive` 仅在读回身份视图（有 active）时携带。

/** `data_gen.seq`（非负整数）；缺失 / 非法回 null。 */
function dataGenSeqOf(value: any): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const seq = value.seq
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null
}

/** 构造写输入槽的 batch directive：保留身份 body 其余键，只覆盖本线程 slots 键。 */
export function slotWriteDirective(
  body: any,
  threadKey: string,
  slot: any,
  expectActive?: string | null,
  dataGen?: any,
): any {
  const base = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const slots =
    base.slots !== null && typeof base.slots === 'object' && !Array.isArray(base.slots) ? base.slots : {}
  const nextSlots = { ...slots, [threadKey]: slot }
  const addGen: any = { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} }
  if (expectActive !== undefined) addGen.expect_active = expectActive
  const seq = dataGenSeqOf(dataGen)
  if (seq !== null && JSON.stringify(slots[threadKey]) !== JSON.stringify(slot)) {
    addGen.base = seq
    return {
      kind: 'write',
      request: {
        op: 'batch',
        args: {
          ops: [
            { op: 'put', args: { body: { ops: [{ op: 'replace', path: ['slots', threadKey], value: slot }] } } },
            { op: 'add_gen', args: addGen },
          ],
        },
      },
    }
  }
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body: { ...base, slots: nextSlots } } },
          { op: 'add_gen', args: addGen },
        ],
      },
    },
  }
}
