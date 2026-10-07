# 计划：框架打包为 npm 包 + `chrono` 插件系统

> 实施计划，不参与设计口径。落地后需回填 / 清理设计文档（见 P6）。
> 本计划按多轮问答口径重写，**以下「已定口径」优先于旧文档**；旧文档多处与发布模型冲突，需清理。
> 状态：已落地（保留作历史记录）；落地结论见 §十一。

## 〇、已定口径（问答结论）

1. **只发布框架一个 npm 包**，不发布任何插件；插件由第三方按规范自产。
2. 框架只负责三件事：**运行、热更、机械处理插件关系**（needs / slots / 绑定 / 闭包）。
3. 插件 = 一个 npm 包；`package.json` 加 `chrono` 字段（标记 + 指向 `plugin.json`）。
4. 插件包可**只带源码**、**只带产物**、或两者；**构建与否由插件自己声明**（`build: []` + `start` 指产物 = 不构建）。
5. **源码（若带）入世供回退 / 审计；产物不入世**；运行期**绝不运行世界里的源码**，跑的是物化 / 包内产物。
6. **无源码的包不入世源码本体**（身份与声明的机械处理见假设 A3）。
7. **热更由插件声明**：`plugin.json.hot` = `auto` | `manual` | `off`。
8. **契约变更加兼容性门禁**：不兼容则拒绝换代、旧版继续服务。
9. 换代 **drain 旧服务**（等在途，上限 `drain_ms`，超时强杀）。
10. 每项目一套 root（现有 `resolveRoot` 模型）；世界与插件集按项目隔离。
11. `chrono add <来源>` 支持三种来源：**本地路径**（目录 link / 归档 `.tgz`·`.tar.gz` 解包）/
    **npm 包名**（registry 拉取）/ **远程 git 仓库**（clone，可选 branch·tag·commit）。
12. **框架必须编译成 JS 发布**：Node 24 对 `node_modules` 下的 `.ts` 报
    `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`（已实测）。插件源码在物化目录（不在 `node_modules`）仍可用 TS。
13. **协议壳 `plugin-sdk` 随框架包内置、由宿主供给、插件可选用、不强制**——限制最少、跨语言最通用
    （JS 壳 + Rust crate；手写协议只要握手合规也放行）。`chain-contract` 砍掉。
14. **toolchain 随框架包内置**（构建期），暴露稳定入口 `chrono term build <dir>`；插件在 `build` 声明里可选调用，
    不用它的插件不写。运行路径不 import toolchain。
15. **用户使用方式写进仓库根 README**；旧文档需清理（见 P6）。

## 一、职责边界

- 框架不认识业务、不认识语言、不挑构建方式：只按 `plugin.json` 声明跑 `build` / `start`、按 `needs` 路由、
  按 `slots` 校契约、按 `hot` 决定是否跟随。
- 插件不 import 框架源码、不互相 import；只经线协议 + `needs` 通信。
- 源码 / 产物 / 世界三分：源码是回退凭据（可入世），产物是可运行件（不入世），世界只存定义与判定。

## 二、框架包构成（只此一包）

```
<框架包>/
├── package.json            # name/version/type/bin=chrono/files/engines>=24；files 仅含 bin / dist / README.md
├── dist/                   # 编译产物（JS + d.ts）：packages（kernel / host / client / boot）+ plugin-sdk + toolchain
│                           #   发布的 SDK 落 dist/plugin-sdk、toolchain 落 dist/toolchain（scripts/build.mjs）
└── README.md               # 用户使用方式（安装 / add / start / 调用 / 升级 / 开发插件）

（仓库根源码，不作为顶层目录发布；编译进 dist 后随包）
plugin-sdk/                 # 服务协议壳（TS + rust/ + web/ + tools/）：宿主供给、插件可选用；排除 rust/target/ 与 node_modules/
toolchain/                  # 构建期 term 编译器（JS + d.ts）：零内核依赖（testkit 除外）
```

- `bin`：`chrono`（可保留一个版本的 `boot` 别名）。bin 指向编译后的入口（或极薄 shim）。
- `chain-contract/`、`templates/plugin/` **不做**（与框架无关，且不发布插件）。
- 运行时代码**不得** import `toolchain`（加静态门禁）；`toolchain` 只由 CLI 子命令或插件 `build` 触发。

## 三、插件包解剖与识别

```
my-plugin/
├── package.json          # name/version/deps/scripts + "chrono": { "plugin": "plugin.json", "api": 1 }
├── plugin.json           # 契约：identity/schema/implements/methods/concurrent_methods/needs/slots/judgments/
│                         #       start/transport/build/exclusive/hot/protocol/restart/health/state/members/commands
├── README.md
├── .worldignore          # 入世排除（构建产物、测试、语言缓存）
├── execute/ | src/       # 服务源码，或直接是产物
├── terms/ | terms.src/   # term 产物（入世）/ 糖化源（排除）
└── schema/
```

- **识别**：`chrono add` 读包根 `package.json.chrono.plugin`（缺省 `plugin.json`）→ 契约；契约 `identity` 是身份名。
- **`hot`**：`auto`（默认，watcher 跟随）/ `manual`（只 `chrono upgrade`/`add` 换代）/ `off`（不跟随）。
- **`build`**：`[{cmd,args}]`，空数组 = 不构建（`start` 指包内产物）；框架不探测语言。

## 四、用户使用方式（写入仓库根 README）

**终端用户**

```
npm i -g <框架包>                 # 1. 装上框架，得到 chrono
cd my-project
chrono add <本地路径|npm 包名|git 仓库>   # 2. 加插件（暂存 + 登记 + 入世）
chrono start                      # 3. 后台起宿主：常驻守护、世界单写者；detached，就绪后命令立即返回
chrono status                     # 4. 看链头 / 已装载身份（经本地 socket 连宿主）
chrono <插件命令>                  #    按插件声明调用（同上，连宿主）
chrono upgrade <name>             # 5. 升级（触发新代码世代）
chrono remove <name>              #    移除（退役）
chrono stop                       # 6. 优雅停机：逆序摘服务并发 drain → fsync → 释放锁
```

- `start` **不是**前台占用终端，而是拉起后台守护；要前台观察日志可直接运行宿主入口（`node <框架>/dist/packages/host/main.js`）。
- 宿主是 **detached 守护**：**关闭终端仍运行**（不随 `SIGHUP` / 控制台关闭退出）。代价：不占终端也看不到 stdout；
  运维日志在 `state/lifecycle.log`。**不是服务管理器**：开机自启 / 崩溃后拉起归 ops，宿主整体崩溃靠外部拉起。
- 每次命令都经 `state/sock/` 的本地 socket 连宿主；宿主没起时 `status` / 插件命令会连不上（`start` 负责拉起来）。

**插件作者**

```
# 写一个 npm 包：package.json(chrono 字段) + plugin.json + 源码/term + .worldignore
chrono add ./my-plugin            # 本地 link，边写边热更（hot=auto 时）
# 发布后他人：chrono add my-plugin  /  chrono add git+https://...
```

- root 缺省 cwd（`--root` / `CHRONO_ROOT` 覆盖）；`state/`、`plugins/` 由框架建。

## 五、目录与数据流

```
<root>/
├── state/                 # 世界 + 运行落盘（永不进世界）
└── plugins/<name>/        # 托管：本地目录 link / npm 解包 / git clone / 归档解包
```

- **add**：取包 → 放 `<root>/plugins/<name>/` → 登记 `state/plugins.json` → 入世 → 按 `hot` 建 / 更新 watch。
- **入世**：有源码 → 源码树入世成代码世代（`commit`/`tree`/blob 指针）供回退；无源码 → 只入世身份与声明（A3）。
- **运行**：宿主物化 active 代码世代 → 按 `build` 构建或直接用包内产物 → spawn 服务 → 端点表；产物落宿主侧 ③，不入世。
- **热更**：`auto` 走 watcher；`manual` 走 `chrono upgrade`；`off` 不跟随。
- **多插件**：每个 `<name>` = 一身份 = 一服务，各自独立换代；跨包只走 `needs`。

## 六、兼容性门禁（新增）

- 换代码世代前，对每个以 `needs` 指向该身份的消费方，按 owner `slots[cap].methods` / 消费方 `needs.methods`
  校验新提供方是否仍覆盖；不满足 → **整次换代拒绝**、旧版继续服务，记运维日志。
- 纯数据世代（term / schema）不触发该门禁。

## 七、toolchain 作用与接入

- **作用**：构建期编译器。读 `terms.src/*.json`（糖化，带 `k` 判别位）→ 校验（引用无环 / `eff` 端口 / 方法声明）→
  降级为 14 原语 AST 的 `terms/*.json`（数据产物，随源码入世）。`lower` / `validate` / `build` / `sourcemap`
  **零内核依赖**；仅 `testkit.ts` 依赖内核，供测试，不进运行路径。
- **接入**：随框架包内置，暴露 `chrono term build <dir>`；插件 `build` 声明里写它，不依赖框架源码、不知道框架安装位置。
- 不用 toolchain 的插件（手写 AST / 无 term / 只带产物）忽略即可。

## 八、分阶段实施

### P0 基线修复

- 修 `packages/host/effect/route.ts:158`（`caps` 显式 `Set<string>`）、`packages/host/host-capability.ts:157`（补参数类型）。
- 修 `packages/kernel`、`toolchain` 依赖不完整（`npm ci`）。
- 跑齐四包 + toolchain 的 typecheck / test；处置文档引用但缺失的 `tests/static/*` 等。

### P1 单包化与构建

- 根 `package.json` + 构建配置（`tsconfig`）+ `dist` 产出；`tsc` 用 `rewriteRelativeImportExtensions`（TS≥5.7）
  把 `.ts` 导入重写为 `.js`，出 `.d.ts`。构建配置文件属发布机制，不是额外交付物。
- 修按路径定位处：`boot/commands.ts` 的 `HOST_MAIN`、`assembly/sdk-provision.ts` 的 SDK 目录定位。
- `bin`：`chrono` 指编译入口（薄 shim 或直接在入口加 shebang）。

### P2 plugin-sdk 接入（已移入，编译 + 供给）

- `plugin-sdk/` 已在仓库根（TS 源码 + `rust/` + `web/` + `tools/`，`exports` 含 `.` 与 `./web`）：
  对照 `docs/protocol.md` §二 / `plugins.md` 核对（帧编解码与 `host/wire.ts` 逐字节一致、帧循环、manifest、
  派发、反向 `port.call`、`reload`/`drain`/`probe`）；**不重写，只接入**。
- 编译 JS；`plugin-sdk` 随框架包以 `dist/plugin-sdk` 发布；宿主准备阶段把编译产物链进物化树（根 `package.json` 当前未声明 `plugin-sdk` 依赖）；
  宿主准备阶段把编译产物链进物化树，插件可裸导入，也可自行实现协议（不强制）。
- 发布排除 `plugin-sdk/rust/target/` 与 `node_modules/`。
- 加静态门禁：插件运行期不得 import `packages/*`；框架运行期不得 import `toolchain`。

### P3 `chrono` CLI 与插件管理

- 命令进 `packages/host/common/framework-commands.ts`：`add` / `upgrade` / `remove` / `list` / `term build`。
- `add`：三来源取包 → 暂存 → 登记 → 入世（宿主未运行）；消费 `hot`。
- 宿主运行中：见 P4。

### P4 运行中热更（协议演进 + 兼容门禁）

- 新增入站动词（`host/wire.ts`、`inbound/dispatch.ts`、`client` 镜像、两侧一致性测试），暂名
  `plugin.ingest { name }` / `plugin.remove { name }`：复用 `watch/reload.ts` + `host-reload.ts` 的
  「重建 → `add_gen` 落账 → `applyWorld`」，在落账互斥段内提交，避开离线 `seed` 的 `writer_busy`。
- watcher 目标（`watcher.ts:45` 启动时解析一次）在 add/remove 后**重解析**；接入兼容门禁；`hot=off` 跳过。
- 记录为协议演进。

### P5 证明：一个可运行插件系统（不出包，放 `fixtures/`）

- 覆盖：needs 路由与绑定、slots 契约、兼容性门禁、热更换代、跨语言（TS + Rust）（待确认：仓内 `fixtures/` 现为 TS/JS + `toy-python`，未见 Rust 插件夹具）。
- 来源覆盖 npm / git / 本地（待确认：仓内未见 npm / git 来源的 e2e 用例）。
- e2e：`add` → 入世 → 起服务 → 调用 → 改源按 `hot` 热更 → 回退 `set_active`。

### P6 文档：写用户指南 + 清理旧文档

- **新增仓库根 `README.md`**：第四节的用户使用方式（终端用户 + 插件作者）。
- **清理 / 改写**（旧文档按仓库树 / 冻结模型写，与发布模型冲突）：
  - `packages/README.md`：冻结声明、无根 workspace、插件目录发现等按新模型改写或拆分。
  - `docs/host.md`：SDK 供给路径（npm 布局）、toolchain 接入（`chrono term build`）、`hot`、兼容门禁、新入站动词。
  - `docs/plugins.md`：`package.json.chrono` 字段、`hot`、`build` 可空 / 产物、无源码包口径。
  - `docs/protocol.md`：新入站动词、客户端镜像。
  - `docs/plugins-overview.md`：引用 66 个不存在的插件与生成器，删除或重标为「示例」。
  - `docs/ui-client-half.md`：引用不存在的 `plugin-sdk/web`、`types/`、多个 UI 插件；按是否保留 SDK web 面决定改写或删除。
  - `docs/term-toolchain.md`：toolchain 改为随框架包内置 + `chrono term build`。
  - `docs/kernel.md`：内核口径大体不变，核对与发布模型无冲突即可。
- 重建文档引用的门禁（plugin-redline / op-name-parity / wire-parity / judgment-in-term）。

## 九、文件级改动（主要）

- 已存在（本次移入，接入即可）：`plugin-sdk/**`、`toolchain/**`。
- 新增：根 `package.json`、构建配置（`tsconfig*`）、`dist/`、根 `README.md`。
- 改：`host/effect/route.ts`、`host/host-capability.ts`（P0）；
  `boot/commands.ts`、`boot/main.ts`（chrono/add/upgrade/remove/list/term build、HOST_MAIN）；
  `host/assembly/sdk-provision.ts`；`host/common/framework-commands.ts`；
  `host/wire.ts`、`host/inbound/dispatch.ts`、`host/inbound/handlers.ts`、`client/index.ts`、`client/protocol.ts`；
  `host/watch/watcher.ts`；`host/assembly/ingest.ts` / `closure.ts`（hot 声明、兼容门禁）。
- 删除 / 不新增：`chain-contract/`、`templates/plugin/`。
- 元数据：原 `packages/*/package.json` 的 `private:true` 处理为发布子包内元数据或剔除。

## 十、假设（已决）

- **A1 暂存目录（已决）**：`<root>/plugins/<name>/`（与现有目录发现一致）。
- **A2 `chrono` 字段（已决）**：`{ "plugin": "plugin.json", "api": 1 }`。
- **A3 无源码包（已决）**：源码本体不入世，但身份与声明仍需可被机械处理（否则 `needs` 绑定与闭包无从建立）。
  与「无源码就不入世」的字面有张力，已明确：无源码包仍入世身份与声明。
- **A4 框架包名 / scope**：已定 `@chrono/framework`（见根 `package.json`）。
- **A5 前置**：`plugin-sdk` 与 `toolchain` 已移入（已解决）；`chain-contract` 按决定砍掉；参考插件仍需按 P5 自建。

## 十一、子代理审查发现（按现状重写）

> 本节按当前仓库状态重写；落地项已回填设计文档。

### A. 代码级

1. **chain-contract 供给链（已解决）**：仓库已无 `chain-contract`——`contractPackageName` / `frameworkContractDir` / `provisionChainContract` 等符号零命中，不再是起服务阻断项。
2. **编译布局下的 SDK 定位（已解决）**：SDK 由框架包根定位，发布形态为 `dist/plugin-sdk`（`scripts/build.mjs` 产出）；`frameworkContractDir` 已不存在。
3. **SDK 发布形态（已解决）**：`plugin-sdk/README.md` 与 `sdk-provision.ts` 均为「编译后的 JS 发布」，无「TS 源码发布」残留。
4. **`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`（已实测）**：由 Node v24.18.0 实测确认。

### B. 文档 / README 清理（按现状）

- **已完成**：`packages/boot/README.md` 已重写为 `chrono` CLI（无 `genesis 常量`）；`plugin-sdk/README.md` 已改「编译 JS 供给」，悬空根 `package.json` 声明与 `tools/rust-sdk-temp-root-check.mjs` 已修正 / 移除；`tests/static/*` 四门禁（`plugin-redline` / `op-name-parity` / `host-client-wire-parity` / `judgment-in-term`）均已存在；`docs/host.md` 的 CLI、`seed`/`pack`、目录发现、保留命令表、`chrono.config.json` 位置均已对齐；`docs/plugins.md` 已含 `concurrent_methods`（19 字段）、无 `templates/plugin/`、§九 已改写为「作者自产」、无 `D-1`/`D-2`；`docs/protocol.md` 已补 `plugin.ingest` / `plugin.remove` / `plugin.ok` 并含 `cancel`；`docs/term-toolchain.md` 已含 `chrono term build`；各包 README 的 SDK 供给措辞、`chrono.config.json` 位置、op 名单来源、公共面表均已对齐；根 `README.md` 已含 `chrono list`。
- **本次修复**：清除设计文档对计划文档的全部引用（含 `docs/host.md` 目录树的 `plans/` 项），清除 `A*` / `G*` / `S*` / `F*` 计划编号残留（文档、`packages/host/**` 注释与测试名、`toolchain/*`）。
- **无需改动（原判断已过时）**：`docs/plugins.md` 的「冻结」措辞与兼容门禁不冲突（v1 契约冻结 + 换代门禁）；`docs/term-toolchain.md` §八 列 `packages/{kernel,host,boot,client}` 是正确的运行期包清单。

### C. 结论

- 已删除（未建 `docs/_archive/`）：`docs/plugins-overview.md`、`docs/ui-client-half.md`、`packages/README.md`。
- 文档层与代码层审查项均已落地；设计文档不再引用计划文档。
- 生成物随本次修复重建：`dist/`、`pack/*.tgz`、`node_modules/@chrono/framework`。
