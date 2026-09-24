# 判定作为数据：实施计划

> 口径来源：`docs/kernel.md`（内核设计，唯一权威）、`docs/term-toolchain.md`（工具链设计）、`docs/plugins.md`、`docs/host.md`。
> 本文件属 `docs/plans/`，只写「怎么做」，不参与设计口径；冲突时以设计文档为准。

---

## 零、总目标与验收

目标：判定以 term 数据形态进世界——改判定 = 一条数据世代（热改、可回滚、可审计），执行件退化为效果驱动。term 的定位是**选择与编排**，不是通用计算。

三条**端到端**验收（实验门的判据，全部在真实运行中验，不用单测代替）：

1. **表达得出**：一个真实判定能用 term 表达，覆盖运行时分支与列表遍历。
2. **热改不换进程**：运行中改判定 → 追一条数据世代 → 目标服务的进程 pid 不变、在途调用不中断。
3. **确定性**：同输入重放决策逐字段一致。

---

## 一、前置（并行、独立于本计划）

**存储有界化必须先落**（`packages/kernel/recycle.ts`、`patch.ts` 及其宿主接线，见 `docs/plans/storage-dedup.md`）。

- 理由：判定进 term 会引入更多 def 与更多世代；base 无界时，A 会**加速**膨胀。
- 退出判据：一次换代的 base 增量 ∝ 实际改动字节，而非全量历史；`packages/host` 的 `host-recycle.test.ts` 绿。
- 本计划与它并行，但步骤六（实验）之前它必须已绿。

---

## 二、步骤 0：判定核补全（内核）

### 0.1 裁决桥的方案

在 `docs/term-toolchain.md` §五 的甲/乙中拍定一个（甲：新增布尔谓词原语；乙：放宽 `if` 接受 `-1/0/1`）。这是内核公共面变更，须先定，后续降级规则据此。

### 0.2 实现（以甲为例，`["pred", op, a, b]` → `Bool`）

| 文件 | 改动 |
| --- | --- |
| `packages/kernel/types.ts` | `TermTag` 增 `pred`（或按裁决结果）；错误码如需扩则同步 |
| `packages/kernel/machine.ts` | `TERM_TAGS` 增头；`evalNode` 分派；新增 `evalPred`（复用 `cmp` 的全序，返回 `Bool`）；形态不合报 `bad_term` |
| `packages/kernel/index.ts` | 公共面无新增函数时不动；若导出则按「加导出 = 改设计」同步文档 |
| `packages/kernel/README.md` | 原语数表述由 8 更新（若甲） |
| `docs/kernel.md` §十三 | 原语清单、`Cmp`/`If` 段落补谓词口径；说明向后兼容（老实现报 `bad_term` 而非算错） |

### 0.3 测试

- `packages/kernel/test/machine.test.ts`：`pred` 各 `op`（含跨型、边界）、形态错 → `bad_term`、`pred` 结果可直接作 `if` 条件。
- `packages/kernel/test/invariants.gates.test.ts`：随机项生成纳入新头；老日志（不含新原语）replay 逐字节不变。
- gas/depth：新节点扣 1、参与深度记账。

### 0.4 验证与退出

- `packages/kernel`：`npm test`、`npm run typecheck` 全绿。
- 退出判据：谓词可与 `if` 组合写出 `if a < b then X else Y`；既有链 replay 逐字节不变。

---

## 三、步骤 1：糖化 JSON 规范 + 编译器核心

新建顶层包 `toolchain/`（**非 `packages/`**——`packages/` 是运行时载体实现；自带 `package.json` / `tsconfig.json` / `test/`）。编译器主入口**零内核依赖**（`docs/term-toolchain.md` §七/§八）。

1. **规范**：落 `toolchain/spec.md`，定义糖化 JSON 的键集与语义（`docs/term-toolchain.md` §三）。
2. **降级器**：`toolchain/lower.ts` 实现 `lit` / `ctx` / `arg` / `let` / `if` / `pred` / `call` / `eff` / `fold` 到原语 AST 的机械映射（`docs/term-toolchain.md` §四）。
3. **`let` 写期宏**：`toolchain/macro.ts`，替换展开；同名 `let` 只展开一次，重复出现按哈希共享。
4. **`ref` 保留**：`call` / `fold` 的函数侧保持包内相对路径，交宿主 A0b 的 `$ref` 机制替换；编译器不解析 callee 内容（故编译器不需要 `H`/求值机）。
5. **确定性**：编译器不读时间/随机/环境；同源两次编译逐字节一致。

验证（`toolchain` 内 `npm test`）：

- 每条降级规则一个用例（含 `let` 嵌套、`pred` 组合、`fold` step 引用）。
- 确定性双跑：同源 → 同一 AST 串。
- 越界语法（算术/构造/递归）编译期报错。

退出判据：任一糖化表达式都能降级为合法 8（或 9）原语 AST，且通过步骤 0 的求值。

---

## 四、步骤 2：TS builder（作者体验层）

`toolchain/builder.ts`：类型化 API，产糖化 JSON 或直接产 AST。

- 覆盖全部糖化键；参数与返回值带类型；非法组合在类型层不可构造。
- 目标是让作者拿到 IDE、类型、单测、重构。
- 跨语言后置：糖化 JSON 是交换格式，Rust/Python builder 后续按同一格式产出，本步只做 TS。

验证：builder 产物与手写糖化 JSON 逐字节等价；`npm run typecheck` 覆盖 builder 用例。

退出判据：用 builder 能写出步骤六实验所需的全部判定。

---

## 五、步骤 3：静态校验器

`toolchain/validate.ts`，编译期 fail-closed（`docs/term-toolchain.md` §六.1）：

- 形态：未知键 / 缺必填 / 类型不符。
- 路径：`ctx` 路径非空 `(str|int)` 数组。
- 引用：`call` / `fold` 的 `ref` 指向包内存在 term；无环（与 A0b `term_cycle` 同口径，工具链提前检出）。
- 效果：`eff` 的 `port` ∈ 自身 `implements` 或 `pins`；`method` ∈ 该能力 `methods`；跨身份只能 `eff`、本身份内才 `call`。
- 边界：不出现算术/构造/递归形态。
- 确定性：编译输入只有源。

验证：每类非法源各一个用例，断言拒绝码；合法源零误报。

退出判据：非法判定在编译期被拦，不进入入世流程。

---

## 六、步骤 4：源映射 + 测试器（内核依赖拆到独立入口）

1. `toolchain/sourcemap.ts`：AST 节点 → 源位置；运行期错误码（`bad_term` / `bad_var` / `missing_path` / `bad_fun` / `missing_ref` / `gas` / `depth` / `eff_error`）回落源行。**零内核依赖**；源映射是作者侧派生物，**不入 ①**。
2. `toolchain/testkit/`（**独立入口，可依赖内核**）：给定 `ctx` / `args` / `effects` 回灌表，调用内核 `evaluate` 求值，断言结果与错误码（与内核共用同一实现）。**由外部工具调用，不放进插件包**——插件只交 fixture，内核依赖因此不进入插件（`docs/term-toolchain.md` §七）。

验证：分支覆盖（含边界值、缺失路径、挂起效果、`eff_error`）；错误定位到正确源行；源映射不随 `terms/*.json` 入世；插件包内文件不 import testkit。

退出判据：作者能在不读内核源码的前提下定位判定错误，且插件包对内核零依赖。

---

## 七、步骤 5：打包 / 构建 / 入世接入

1. **源的位置**：判定源住插件包内（糖化 JSON 或构建脚本）；产物 `terms/*.json` 入 ①。
2. **构建步骤**：在 `plugin.json.build` 增加编译步（宿主只执行、不解释；与现有构建声明同性质）。构建脚本是**不入世**的包内文件，可 import `toolchain` 编译器（编译器零内核依赖，故不传递内核）。
3. **依赖边界**：插件**运行期**（`execute/` / `src/` / `terms/` / `schema/` / `plugin.json`）与入世内容**不得** import `toolchain`；`toolchain` 不进 `state/plugins.json`、不参与 `pins`/路由（`docs/term-toolchain.md` §八）。
4. **`.worldignore`**：排除源映射与构建脚本（按包声明）。
5. **入世校验**：`packages/host/validate-package.ts` 的 dry-run 保持不变（只做机械校验，不解释糖化语义）。

验证：造一个 toy 包，源 → 构建 → 入世 → `eval` 跑通；`validate_package` 行为不回归。

退出判据：新增一个用 DSL 源的包，只加包 + 构建声明即被连接生效。

---

## 八、步骤 6：单判定实验（Go / No-Go 门）

**只做一件事**：选最纯的判定迁移——`router.select`（候选选择）或 `guard.judge` 的纯判定部分。

1. 判定写成 term（用步骤 1–4 的工具链），执行件退化为「取数 / 出效果」。
2. 端到端验三条验收：表达得出 / 热改不换进程（验 pid 不变）/ 重放决策一致。
3. 记录：源行数与复杂度、判定作者（尽量非内核作者）耗时、需要工具链补的能力。

**kill criterion（写死，不许拖）**：三条验收任一不过，或判定作者认为不可维护 → **停，走 B**（承认判定归执行件，按步骤十同步文档），不硬推。

退出判据：三条全过，且记录支持「第三方作者可写」的判断。

---

## 九、步骤 7：增量迁移

按插件逐个迁，每个独立可交付、可回滚：

1. 先纯判定：`router`、`guard`。
2. 再编排：`loop-policy`。
3. 最后大件：`orchestration-admin`。

每个插件：判定进 term；执行件只剩取数/效果；服务契约与测试同步；单独跑通三条验收。

**不迁**（按 `kernel.md` §十 四向判据）：model 调用、fs、sandbox、embedding 等效果重件——它们的「语言生态 / 进程隔离 / 可丢弃可重算」属性决定它们就该住执行件。

退出判据：目标插件的判定源全部住 term；执行件无判定分支（可用静态扫描辅助）。

---

## 十、步骤 8：防再漂门禁 + 文档同步

1. **门禁**：加一条约定/静态扫描（或测试），标记「纯判定不得只写在服务代码里」；命中即告警。落点与现有源码静态扫描测试同处。
2. **文档同步**（把与实现相反的口径改到一致）：
   - `docs/host.md`:6「判定 / 路由 / 评分 / 门禁一律是 term」。
   - `docs/plugins.md`「回合循环由宿主通用 run loop + term 承担」；红线 1 补「仅不入世的构建/开发脚本可 import 工具链编译器；运行期与入世内容不得 import；编译器零内核依赖」。
   - `docs/kernel.md` §十三 原语清单与判定核补全口径。
   - `packages/kernel/README.md` 原语数表述。
   - `packages/README.md`：顶层布局加 `toolchain/`；依赖方向段补「运行时不得依赖 toolchain」。
   - 新建 `toolchain/README.md`：定位（第一方作者工具、非运行时）、依赖边、不进 ①。

退出判据：文档口径与代码一致；门禁在示例漂移上能告警。

---

## 十一、风险与不做的事

**风险**

- **生态没人写**：工具链是成败点。缓解：以「第三方作者不读内核源码能写出并改对判定」为硬门（步骤 2/6）。
- **表达力边界**：无算术、无数据构造 → 数值计算/构造归执行件。若不接受，须另做内核原语扩展（另立项）。
- **性能**：判定从代码变求值机 + def 查表，可能更慢；`fold`/`eff` 的续跑是 O(k²)。缓解：效果放叶子、长循环拆 directive（`kernel.md` §十二）；实验步骤内观察。
- **源与产物双形态**：糖化源与编译产物须长期共存；源映射不入世，漏排会污染 ①。
- **迁移期双形态世界**：迁一半时 term 判定与代码判定并存，路由/审计口径须能同时容纳。

**不做的事**

- 不做可视化判定编辑器。
- 不把 lambda / 递归 / while 纳入（内核设计拒绝；加它们属换模型，不属原语扩展）。
- 本计划不扩算术 / 数据构造原语（当前原语不具备；若要，属独立的内核原语扩展立项，不在本计划内）。
- 不把编译器放进宿主或内核。
- 不把源映射、构建脚本塞进 ①。
- 不在存储有界化落地前启动步骤六。
