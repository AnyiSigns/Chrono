# config（用户模型配置）

用户配置的**单一真源**：厂商连接实例（`base_url` / `auth_ref`）+ 模型目录与元数据 +
参数 / 权限档 / 主题 / 语言 / 侧栏宽度 + 当前选择。
本包是**服务**：`config.read` / `config.write` 两个命令；运行记录住自有持久存储（④）。

## 身份与数据

- 身份：`config`
- body 顶层：`version` / `vendor` / `model` / `params` / `permission` / `ui` / `providers`；
  `required` = `version` / `params` / `permission` / `ui` / `providers`，其余按需缺键。
- 缺键语义：无 `vendor` 键 = 尚未完成首启配置（判「无配置」的判据）。
- `permission` 四档：`auto` / `severe` / `review` / `deny`。
- `ui.theme` 三档：`day` / `night` / `system`；`ui.sidebar_width` 范围 220–420。
- `providers` 键 = 厂商身份名，值为连接实例 + 模型目录；`auth_ref = { kind: "local" | "env", name }`
  **只存引用不存密钥本体**。
- 形状校验归写入端（宿主不校验身份数据）。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `version` | 运行记录（出世界）+ 阈值镜像 | 存储格式版本；随阈值子集镜像进世界 |
| `vendor` | 运行记录（出世界） | 当前厂商选择属用户配置；判定不读、回滚不该带 |
| `model` | 运行记录（出世界） | 当前模型选择属用户配置 |
| `ui.theme` / `ui.language` / `ui.style` / `ui.sidebar_width` / `ui.notify` | 运行记录（出世界） | 界面偏好；写者（ui-shell 主题 / ui-sidebar 宽度 / ui-composer）经 `config.write` 写自有存储 |
| `providers` | 运行记录（出世界） | 厂商连接实例 + 模型目录（用户配置）；`auth_ref` 只存引用 |
| `permission` | **判定阈值（留世界，镜像）** | 全局权限档：guard / sandbox 门禁读；回滚应带上；`config.write` 变化时镜像进世界 |
| `params`（temperature / reasoning / max_tokens） | **判定阈值（留世界，镜像）** | 模型参数阈值（推理强度 / 上限）；调用判定读；变化时镜像进世界 |

**结论**：纯用户配置 / 界面偏好出世界；判定阈值 `permission` / `params` 留世界（镜像），读写经 owner。

## 提供哪些命令

- `config.read`（只读，无参）：入口 term 取 `ctx.ids.config` 世界切片作基线，经 `eff` 问 owner 服务；
  服务把世界基线 + 自有存储合并后回整份视图（`active` / `body` / `data_gen` / `pins` / `refs`）。
  调用方取 `body` 为配置本体。**服务不读投影**（世界切片随 args 传入）。
- `config.write`（补丁）：入参 `{ patch }`，深合并（`null` 删键）读-改-写自有存储。
  `ui` / `providers` / `vendor` / `model` 只落 ④；`permission` / `params` 变化时额外返回世界写计划
  （`put` 阈值子集 + `add_gen(config)`），把判定阈值镜像进世界。仅运行记录变化时不产世界写计划。

## 怎么起

`start: node execute/main.ts`；`pins` 无；`exclusive: ["data"]`（④ 单写者）。

## 状态档

`state: "durable"`（④ 不可重算；运行记录跨代存活、进备份、只按身份消失回收）。

## 存储引擎与落点（自写）

- ④ 落点：`CHRONO_PLUGIN_DATA/config.jsonl`，单文件追加日志（每条一次 append + fsync，换行收尾）。
  记录 `{t:'body', run, body}`；启动重放取最后一条 body，末行半写撕裂 / 坏行跳过（fail-open）。
- **边跑边追加**：`config.write` 即时写一条记录；同内容重复写幂等短路；每条记录盖回合 id（`run`）。
- **存量不搬**：存储从空开始；读时把世界遗留 body 作基线合并（存量可读），但不写回世界。
- **清理责任**：自写存储；owner 退役时宿主按身份回收删除 `state/data/config/`，无需额外清理方法。

## 默认 body 预置（可复现）

- `tools/default-body.json`：默认 body（`version: 1`、无 `vendor` / `model`、`params` 保守默认、
  `permission: "review"`、`ui.theme: "system"`、`ui.style: ""`、`ui.sidebar_width: 260`、`providers: {}`）。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入（`put` + `add_gen`），
  作为首启基线（`config.read` 合并世界基线 + 自有存储）。可重复执行。

```
node plugins/config/tools/seed-default-body.mjs --root <宿主根目录>
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `terms/` / `execute/`）随源码入世。
