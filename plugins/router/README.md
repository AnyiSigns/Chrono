# router（模型 / 能力选择）

模型 / 能力选择：按候选端口名清单 + 失败码做**纯判定**，返回选中的端口名。
调用面是编排服务的**降级判定**（某能力端口失败后，按本插件的返回名改调备选实现）。
本插件只选、不调：不发起 eff、不调模型、不读投影、不写世界、不改任何调用方的 `pins` 指向。

- 身份：`router`
- 能力类 / 方法：`router` → `select`
- 判定：`plugin.json.judgments` 声明 `router.select = terms/select.json`——判定住 term，
  由宿主路由命中时**就地求值**，无执行件、无服务进程
- 成员：`term`（`terms/`）、`schema`（`router.json`）
- `pins`：无（`select` 是纯判定，不依赖其他身份）
- 状态档：`recomputable`（无状态；同输入同输出，可回放）
- 进程：无（判定是数据，不 spawn 服务）

## 判定作为数据

`select` 判定不是服务代码，而是世界里的 term def：

- 改判定 = 写一条数据世代（`put` + `add_gen`）→ 热生效、进程不动、可回滚、可审计。
- 判定是**纯项**：不发起 `eff`（取数 / 效果归服务方法，判定只做选择与编排；发射 `eff` 即 fail-closed）。
- 源在 `terms.src/select.json`（糖化 JSON），产物 `terms/` 随包入世；源由编译器生成、不入世。

## `select(args)` 入参

```jsonc
{
  "candidates": ["model", "model-alt"], // 调用方自己 pins 的候选端口名清单，顺序即偏好序
  "failure": "model_server_error", // 失败码（作数据传入；v1 不参与判定）
  "aliases": ["model-alt"], // 可选：别名清单；缺省取空数组
  "primary": "model", // 可选：主端口名；缺省取 model
}
```

- `candidates` 必填、非空、每项非空字符串；候选清单由调用方给出（调用方的 `pins` 里有这些端口名）。
- 本插件不认识任何具体实现。

## `select` 返回

- **成功**：选中的端口名（**字符串**）。
  - 有别名候选（候选清单里出现被声明的别名）→ 取**候选清单顺序里第一个**这样的别名。
  - 无别名候选 → 恒返回**主名**（机械 no-op）。
  - 返回名**必在候选清单内**；候选清单里既无主名也无任何被声明的别名 → 结构化错误值
    `{ok:false, error:{code:'no_candidate', message}}`，不硬选。
- `failure` 接受但 v1 不参与判定、不回传。

## 别名清单（本身份数据世代 body）

形状已冻结（出生即固定）：`{"primary":"model", "aliases":[]}`。

- `schema/router.json` 是身份数据契约，声明形状与冻结默认值（`primary` 默认 `model`、`aliases` 默认 `[]`）。
- **别名清单住本身份数据世代 body**（不住 schema）：调用方读出后随 `args.aliases` 传入；
  加备选实现 = 写数据世代（`put` + `add_gen`，进程不动、热生效）。
- `args.aliases` 缺省时按空数组判定。
- `tools/default-body.json` 是默认 body 的结构化形态；`tools/seed-default-body.mjs` 在宿主已 `start` 时提交一条数据世代写入（可重复执行；同 body 命中 `put` 幂等，但会追加一条数据世代）。

```sh
node plugins/router/tools/seed-default-body.mjs --root <宿主根目录>
```

## 边界

- 不做：调用实现（只选，不调）/ 改调用方 `pins` 指向 / 重试 / 退避 / 限流 / 流断重连（归模型 IO 服务）/
  落账 / 图拓扑与节点选择（归编排服务）。
- 无执行件：判定是数据，运行期零依赖、不 spawn 进程。

## 运行

```sh
npm test                          # 包形状测试（node --test）
node ../../toolchain/build.ts .   # 由糖化源 terms.src/ 重编译产物 terms/
node tools/e2e-smoke.mjs          # 宿主装配 E2E（pack → seed → start → 写数据世代 → stop → verify/replay → 离线投影）
```

> 编译是作者侧步骤：`terms.src/` 被 `.worldignore` 排除、不入世，产物 `terms/` 随包入世；
> 故 `plugin.json.build` 为空。

## `.worldignore`

声明 `test/`、`tools/`、`terms.src/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `terms/` 随源码入世。
