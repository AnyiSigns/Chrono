# uislot-fixture

端到端测试夹具：`ui-slot` / `ui-nav` 扩展类提供方。

- `ui-slot.list` 返回 `{ slots: [{ name: 'statusbar', kind: 'chrome', mount: 'bottom' }] }`——
  壳按数据在底部停靠区渲染新增槽，不要求改壳源码。
- `ui-nav.list` 返回一条页面导航记录（`{ id, label, icon, target: { page } }`），经壳汇集进侧栏。

加入世界即被壳按 `many` 成员表汇集：加本插件不改 `ui-shell` / `ui-sidebar`。
