# #42 `plugin-admin`（agent 的插件管理面）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 42 / `plugin-admin` |
| 职责 | agent 的插件管理面：列插件 / 读源码 / 校验 / 写新源码（产出写计划）；**可见性黑名单 = {`sandbox`, 自己}**（与「受保护 `pins` 身份表」是两回事，见修正 1 / 2） |
| 依赖 | `->` **保留身份 `host`**（pins：`host` → 宿主自身；`read` 走 `host.source.read`、`validate` 走 `host.validate_package`）；`<-` 27（pins：以工具类 `plugin-admin` 暴露给 agent） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["plugin","plugin-admin"]`，`methods: {plugin:["list","read","validate","write"], "plugin-admin":["describe","invoke"]}`；**工具名 = `plugin.list` / `plugin.read` / `plugin.validate` / `plugin.write`**（D2 / D-命名空间：类名 = 身份名，工具名带 `plugin.` 前缀全局唯一；见 `plugins/tools/DESIGN.md`「`tool` 端口契约」） |
| 命令 | 无 |
| schema | `schema/plugin-admin.json`（源码大小上限等**非安全参数**；**可见性名单与受保护 `pins` 身份表不在此处** —— 见「修正 2」） |
| 机制 | 见下 |
| 边界 | 不做：改内核 / 改宿主 / **绕过可见性过滤** / 装配与换代（归宿主 `assembly`）/ 直接写链（只返回计划）/ 人可见的插件页（归 #17 S9，只读）/ **改 #33 的图数据**（归 #45 `orchestration-admin`，见下） |
| 验收 | 见下「验收」 |
| 状态 | 细节设计（2026-09-19）：**三处修正** —— 受保护 `pins` 不可删（补一个真漏洞）、可见性名单移入包内、`plugin.validate` → `plugin.write` 强制顺序 |

> **为什么这样不破口径**：限制落在**本工具自己的可见性策略**与**宿主的 `pins` 层机械校验**上，沙箱仍是普通插件；框架唯一不变量仍是**内核不可改**。agent 改插件的**唯一**路径 = 本工具（`#27` 暴露），故过滤即隐藏。

---

## 机制

- `plugin.list(bag)`：返回宿主已知的插件身份（身份名 / **世代 64-hex 哈希** / `pins` 摘要）；**过滤掉可见性黑名单 {`sandbox`, 自己}**。
- `plugin.read(bag)`：读某身份的源码——经 **`host.source.read {identity, path}`**（保留能力类 `host`，H3）；被黑名单过滤的身份 → `hidden_identity`（本插件先过滤，不调宿主）。
- `plugin.validate(bag)`：经 **`host.validate_package {files}`**（保留能力类 `host`，H13/D12）转发宿主的入世前校验 dry-run——对 `plugin.json` 12 字段 / 包内路径约束 / `argsSchema` 方言 / **受保护 `pins` 完整性** / term 环 / `.worldignore` 做 dry-run，返回错误列表与 **`result_hash`**；机械校验归宿主，本插件只转发。
- `plugin.write(bag)`：构造世界写计划（**不直接写**）：**身份不存在时先 `add_identity`（否则只 `add_gen`）** → `put(blob)` × n → `put(tree)` → `put(commit)` → `add_gen(身份, payload=commit)`；批内用 `{"$n":k}` 占位串起。**必须携带上一次 `plugin.validate` 的结果哈希**（见修正 3）。
- **风险分级**：写插件 = 改世界源码（非工作区、非工具产物）→ 高危；**按 `(port, 工具名)` 机械判（D4）——`(plugin-admin, plugin.write)`**；**仅 `auto` 档允许直落**，否则升级弹卡（`#26` / `#33`）。

---

## 三处修正（2026-09-19）

### 修正 1：受保护 `pins` 不可删（补一个真漏洞）

**漏洞**：可见性过滤是**黑名单**，而攻击面在**依赖关系**。原设计只过滤 `sandbox` 与自己，但 agent 仍可：

- 写 `tool-fs` / `tool-shell` 的源码，让它**不 pin `#25 sandbox`** ⇒ 工具不经沙箱 ⇒ **四档 fs 强制失效**；
- 写 `#26 guard` 的判定 ⇒ 危险操作不再升级弹卡；
- 写 `#27 tools` ⇒ 改派发目标、绕开受保护工具。

**修正**：`plugin.write` / 入世时机械校验——**新世代的 `pins` 不得删除对受保护 `pins` 身份（表见下）的引用**，删了整批拒 `protected_pin_removed`。

| 受保护 `pins` 身份（仅用于 pins 不可删校验，≠ 可见性黑名单） | 保护什么 |
| --- | --- |
| `sandbox`（#25） | 四档 fs 强制 + 一次性 `caps.grant` 消费 |
| `guard`（#26） | 危险 / 越界升级判定 |
| `secrets`（#24） | 密钥只经句柄、不落明文 |
| `approval`（#32） | 审批队列与回执 |

- **这条落在宿主入世校验，不在本插件**：`pins` 是宿主解析的（`plugins.md` §二「引脚未解析即拒」同路），
  **宿主不需要认识业务**——它只比较"旧世代 `pins` 里有、新世代没了"。
- **受保护 `pins` 身份表住宿主侧**（见修正 2：受保护表钉宿主侧、可见性名单钉包内），不住世界数据。
- 与 `orchestration-admin` **共同受此约束**（两个管理面同一条红线）。

### 修正 2：可见性名单与受保护表必须住包内 / 宿主侧，不能住世界数据

**问题**：原设计名单住 `schema/plugin-admin.json`（**世界数据**），但**改数据不用经本插件 `plugin.write`**——
agent 可让别的路径产出 `add_gen(plugin-admin, 新数据世代)` 直接改名单。
`host.md` §落账 明写 **v1 无 op 级鉴权**（term 可产任意 op、宿主不限制改哪个身份）
⇒ **名单在世界数据里等于没锁**，"针对自己的 `plugin.write` 一律拒"也拦不住这条旁路。

**修正**：

- **可见性名单钉在包内**（`execute/` 或包内常量文件，随代码入世）⇒ 改它 = **代码换代** = 走人闸；
- **受保护 `pins` 身份表钉在宿主侧**（入世校验用，不进世界）⇒ 连代码换代也改不动；
- `schema/plugin-admin.json` 只保留**非安全参数**（源码大小上限等）。

### 修正 3：`plugin.validate` → `plugin.write` 强制顺序

原设计 `validate` 可选。**写死**：`plugin.write` 必须携带上一次 `plugin.validate` 的**结果哈希**（同一 bag / 同一源码树），
否则拒 `validate_required`。理由：把"运行时才炸"提前到写期，与 #33 机械闸同一口径；
且换代失败即 **fail-closed 隔离、绝不回落旧世代**（`plugins.md` §五），事后补救成本远高于事前校验。

---

## 与 #45 `orchestration-admin` 的分工（不合并的三条理由）

| | #42 `plugin-admin`（本插件） | #45 `orchestration-admin` |
| --- | --- | --- |
| 写什么 | 插件包 `execute/` 源码 | #33 的图数据 |
| 生效 | **代码换代**：新服务 + 握手 + 旧服务 drain | **热生效**：进程不动 |
| 失败 | **fail-closed 隔离**，绝不回落旧世代 | 回滚 = 一条 `set_active` |
| 产出 | **写计划**（审批闸在执行前拦） | **提案条目**（门禁在采纳前拦） |
| 安全语义 | 依赖完整性（修正 1） | 图不变量（六条） |

1. **代价与生效语义完全不同**：塞进一个 `plugin.write` 后面挂两套风险，权限档也没法分开配。
2. **安全语义不同**：混在一起两套语义互相污染。
3. **边界冲突**：本插件边界已写明"装配与换代归宿主"、它不认识图；让它认识 #33 的数据 schema 就是越界。

**一处刻意的不对称（写明理由）**：本插件产写计划、#45 产提案条目。
根因是**影子回放**——编排变更能用历史输入 + 审计回灌验证（零 token），所以需要提案态承载影子指标给人裁决；
**源码变更换的是进程，跑不了影子回放** ⇒ 提案态对它没有额外价值，只多一跳。

**必须明写的限制**：`host.md` **v1 无 op 级鉴权** ⇒ "本插件不改图、编排面不改源码"是
**工具面约定 + 审批闸**，不是内核强制。要硬强制需要 op 级鉴权，属后置档。

---

## 宿主待补能力

- **插件源码读面**：`host.source.read {identity, path} -> {path, content(base64), size}`——把某身份的源码 `tree` / `blob` 按路径读给插件。世界 ① 有源码，但投影**不含** `tree` / `blob`（`host.md` §五 投影），故需宿主提供只读读面；已登记为保留能力类 `host` 的方法（H3）。
- **入世校验「受保护 `pins` 不可删」**（修正 1，本轮新增）：跨代比对 `pins`，删除受保护引用即整批拒 `protected_pin_removed`。受保护 `pins` 身份表住宿主侧；**该表只用于 pins 不可删校验，与可见性黑名单 {`sandbox`, 自己} 无关**。
- **入世校验 dry-run 面**（D12，已登记）：`host.validate_package {files} -> {ok, errors, result_hash}`——跑同一套 `plugin.json` / 路径 / `argsSchema` / 受保护 `pins` / term 环校验但**不写世界**，供 `plugin.validate` 转发；属宿主前置能力 H13（实现须先于 #42 验收）。

---

## 验收

1. `plugin.list` 不出现可见性黑名单身份（`sandbox`）与自己；
2. 针对黑名单身份的 `plugin.read` / `plugin.write` 一律 `hidden_identity`；
3. 写 = 计划 `put(blob/tree/commit) + add_gen`、可回放（身份不存在时含 `add_identity`）；
4. 换实现不改 #27；
5. 非 `auto` 档下写插件被拒或升级弹卡；
6. **删除受保护 `pins` 的世代入世即拒** `protected_pin_removed`（如提交一个不 pin `sandbox` 的 `tool-fs`）；
7. **改可见性名单必须走代码换代**（世界数据里没有该名单，`add_gen(plugin-admin, 数据世代)` 改不动它）；
8. **缺 `plugin.validate` 结果哈希的 `plugin.write` 被拒** `validate_required`；
9. **身份不存在时 `plugin.write` 计划先 `add_identity`、已存在时只 `add_gen`**。

---

## 渲染（`describe.render`，本轮定）

| 工具 | `form` | `label` | `summary` | `tone` | `detail` |
| --- | --- | --- | --- | --- | --- |
| `plugin.list` | `card` | `plugin` | `list` | **`solid`** | `{kind:"list"}`（插件身份清单，已过滤） |
| `plugin.read` | `card` | `plugin` | `read  {identity}` | **`solid`** | `{kind:"code"}`（源码，按路径分片） |
| `plugin.validate` | `card` | `plugin` | `validate  {identity}` | **`solid`** | `{kind:"json"}`（机械闸 dry-run 结果） |
| `plugin.write` | `card` | `plugin` | `write  {identity}` | **`solid`** | `{kind:"diff"}`（源码写计划的 diff） |

- **高危写类用 `solid`**（实底，与只读工具的 `ghost` 明确区分）：默认收缩显示 `op + identity`，展开看源码 / diff / 校验结果。
- `plugin.write` 卡片在**审批前**就出现（写计划已产、等 #32 裁决）；裁决结果以**状态角标**更新，不改卡片内容。

## 跨插件登记

- **#25 sandbox**：对 agent 隐藏（本插件**可见性黑名单**过滤）+ **受保护 `pins` 不可删**（修正 1）⇒ agent 既改不着沙箱、也不能让工具绕开它；沙箱仍可被**人**经入站面改（保持普通插件）。
- **#26 guard / #24 secrets / #32 approval**：同列**受保护 `pins` 身份表**（仅 pins 不可删校验，≠ 可见性黑名单），`pins` 不可删。
- **#27 tools**：本插件以工具类 `plugin-admin` 暴露，`#27` pin 本插件并纳入工具目录（与 #45 同路）。
- **#17 ui-settings S9**：人可见的插件页仍只读，不经本插件。
- **#33 loop-policy**：图变更不经本插件（归 #45）；本插件的 `plugin.write` 受 #33「审批段不可绕过」同一红线约束。
- **#26 guard / #32 approval / #39 ui-approval**：本插件的 `(plugin-admin, plugin.write)` 判为高危 ⇒ `escalate` ⇒ 入审批队列，
  item `kind = plugin_write`（摘要 = 插件身份 + 变更文件清单 + `plugin.validate` 结果；**无影子指标**，换的是进程、跑不了影子回放）。
