// 夹具的中立声明产物：`ui-slot.list` / `ui-nav.list` 的回值。
// 服务入口与端到端测试共用同一份，测试据此证明「壳按数据合并 / 汇集」确有输入。

export function slotDeclsValue() {
  return { slots: [{ name: 'statusbar', kind: 'chrome', mount: 'bottom' }] }
}

export function navRecordsValue() {
  return {
    records: [
      {
        id: 'fixture-page',
        label: '夹具页',
        icon: 'folder',
        target: { page: 'fixture-page' },
        order: 1,
      },
    ],
  }
}
