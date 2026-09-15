# 仓库布局，暂不用看

> 一句话：**代码与数据分家；我们写的插件与第三方插件在代码上不可区分。**
>
> 上游：`kernel.md`（内核设计与落地规格）、`stages.md`（阶段开发）。

---

## 1. 总树

```
agent/
├── docs/                     设计与规范
│   ├── kernel.md             内核设计与落地规格
│   ├── stages.md             内核之后的阶段开发
│   ├── layout.md             本文件
│   ├── coding-standard.md    编码规范
│   └── code-review.md        代码审查规范
│
├── packages/                 系统本身（我们"拥有"的代码）
│   ├── kernel/               内核：可复现世界 + 谱系 + 机械校验（零依赖）
│   ├── host/                 驱动器 + 持久化 + 装载器
│   └── app/                  产品壳（S9）
│
├── plugins/                  我们写的插件（与第三方同形，只当依赖消费）
│   ├── model-openai/         端口实现：模型
│   ├── exec-local/           端口实现：进程 / 沙箱
│   ├── store-file/           端口实现：存储
│   ├── approve-auto/         端口实现：批准
│   └── ui-min/               观测界面（S6）
│
├── packs/                    数据包：纯 JSON，禁止出现任何 .ts
│   ├── base/                 宏 + 执行器 + schema（S2）
│   ├── judge/                确定性判定标准（S3）
│   └── evolve/               提案 / 审核 / 回滚的规则（S4）
│
├── scripts/                  构建 / 生成 / 门禁脚本
├── config/                   环境与构建配置
├── .github/workflows/        CI（预检 → 审查 → 裁决）
│
├── package.json              workspaces: ["packages/*", "plugins/*"]
├── tsconfig.base.json
├── .prettierrc  .editorconfig  .gitignore
└── README.md
```

---

## 2. 三个区域，三种形状约束

| 区域 | 是什么 | 形状约束 | 消费方式 |
|---|---|---|---|
| `packages/` | **系统**：内核、宿主、产品壳 | 同层内可互相 import | 直接 import |
| `plugins/` | **我们写的插件** | 与任意第三方插件**完全同形**：独立包、有 `package.json`、声明式 | **只按包名（依赖）消费** |
| `packs/` | **数据包** | 纯 JSON | 运行时读文件，经 `batch` 写入世界 |

---

## 3. 端口类别不写在名字里

端口实现的"身份"是**声明里的一条数据**，不是目录名也不是包名。

```jsonc
// plugins/model-openai/plugin.json
{
  "implements": "model",                  // ← 类别在这里，是数据
  "methods": { "complete": { "args": "<hash>", "returns": "<hash>" } },
  "caps":     { "model": true },          // 需要哪些能力
  "pins":     { "sdk": "<hash>" },        // 依赖哪些绑定
  "sig":      "<hash>",                   // 兼容性签名
  "metric":   { "observe": ["runs", "cost"], "score": "<hash>" }
}
```

所以**不叫 `port-model/`**：`port-*` 会把"它实现哪个端口"焊进命名，等于在文件系统里维护一份内核本该不认识的类别表。**加一个端口应当是数据改动，不是目录改动。**

---

## 4. 三种来源，消费侧平等

| 来源 | 物理位置 | 在依赖里的样子 |
|---|---|---|
| 我们写的插件 | `plugins/<id>/` | `"@ours/model-openai": "workspace:*"` |
| 第三方插件 | `node_modules/` | `"@someone/other-model": "^1.2.3"` |
| 第三方数据包 | 任意（npm 包或一份 JSON） | 运行时读入，不进口依赖也可 |

**系统看不到区别**：装载器按清单装载，而**清单在世界里**（数据），不在构建配置里。所以"该装什么"与"仓库长什么样"是两件事。

---

## 5. 目录级门禁（全部可测）

| # | 门禁 | 断言 |
|---|---|---|
| L1 | `packs/` 是纯数据 | `packs/**` 不存在 `*.ts`；任何代码包不得 `import` `packs/**`（只能运行时读文件） |
| L2 | 插件只当依赖消费 | `packages/**` 源码里不出现指向 `plugins/**` 的相对 import |
| L3 | **第一方无特权** | 把 `plugins/` 全部移除并从 `dependencies` 摘掉，`packages/kernel` 与 `packages/host` 的构建与测试**仍全绿** |
| L4 | 内核零依赖 | `packages/kernel/package.json` 的 `dependencies` 为空对象；源码只有包内相对 import |
| L5 | 无内建特权 | 不存在 `builtin/` / `official/` / `core-*` / `internal-*`；不存在任何"内建清单"文件（清单是世界数据） |

**L3 是这套布局的验收点**：跑不起来，说明存在内建特权。

---

## 6. 各阶段往里加什么

| 阶段 | 新增 | 区域 |
|---|---|---|
| S0 | `packages/kernel/` | 系统 |
| S1 | `packages/host/`、`plugins/store-file/` | 系统 + 插件 |
| S2 | `packs/base/` | 数据 |
| S3 | `packs/judge/` | 数据 |
| S4 | `plugins/approve-auto/`（+ 人批端口）、`packs/evolve/` | 插件 + 数据 |
| S5 | `plugins/model-openai/`、`plugins/exec-local/` | 插件 |
| S6 | `plugins/ui-min/` | 插件 |
| S7 | `packages/host/` 扩充样本导出 + 一个外部训练器包 | 系统 + 插件 |
| S8 | **不新增** | — |
| S9 | `packages/app/` | 系统 |

**S8 不新增目录**，这正是这套布局的验证：接生态只改世界里的一份清单，不改仓库结构。

---

## 7. 有意不存在的目录

`builtin/`、`official/`、`core-plugins/`、`internal-tools/`，以及按类型切的 `tools/`、`commands/`、`domains/`、`nodes/`。

一旦出现这类目录，就意味着有人在文件系统里维护一份"类别表"——而类别应该是数据。

> 判断某个东西该不该有独立目录：**如果加一个新分类需要改目录结构，那就不要用目录表达分类。**
