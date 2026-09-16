# DataGraphLab — 数据引擎路线：合成数据生成器 + 可执行验收器 + teacher 轨迹 → SFT/蒸馏可微控制器

状态：设计定稿，未开工。目录 `experiment/DataGraphLab/`（当前为空），与
`experiment/GraphLab/` **完全独立**（不 import 其代码，只借鉴 typed-state 契约与
可执行验收两条已验证机制）。GraphLab 由另一 agent 走在线 REINFORCE/难域重构路线，
本计划不触碰。

> **语言**：正文/附录 A–D 的 `.py` 文件名为**算法规格命名**；实际落盘语言以
> **附录 F** 与第 9 节目录为准——除唯一 Python 训练器 `controller/train.py` 外，
> 全部实现为 **TypeScript（`.ts`）**。跨语言只经 `records.jsonl` / `weights.json`。

---

## 0. 一句话命题

> 在线 REINFORCE 在真实域失败不是因为"图不可训"，而是因为**监督信号要靠白手探索获得**
> **且长程信用分配（≤8 步只有终局信号）拖垮样本效率**。把信号来源从"奖励探索"换成
> "**程序化生成器（答案由构造给出）+ 可执行验收器（答案由独立执行判定）**"，逐 step 监督
> 就把信用分配成本兑换成**可版本化的数据量**：teacher 轨迹 → BC/SFT → 蒸馏出一个**可微
> 控制器**，用数据量换取性能（scaling），而不是用采样运气换梯度。

三个必须先钉死的问题：

1. **标签从哪来？** 生成器先采样"计划"再合成输入，计划即 gold → 标签免费、可无限扩产。
2. **信号可不可信？** 可执行验收器只看公开产物、独立重算真值，**永不接触 gold plan**；
   控制器特征向量里也没有生成器内部 id（防泄漏）。
3. **学什么？** 学一个可微的**路由/编排控制器**（在动态候选节点集上打分的 pointer 式
   策略网络），用交叉熵模仿 teacher、用 KL 蒸馏 soft label；**不是**策略梯度。

---

## 1. 为什么这是"唯一能把训练兑换到规模"的路

| 维度 | 在线 REINFORCE（GraphLab 路线） | 数据引擎（本路线） |
|---|---|---|
| 成功信号 | 稀疏，真实域 0%，采不到 | 生成器保证每个任务可解，稠密 |
| 每步监督 | 只有终局 reward | teacher 给出逐步 target action |
| 成本 | 每任务 N 次 LLM/rollout | 生成+验收近零成本（纯程序化） |
| 平稳性 | fallback 换模型 = 转移函数漂移 | teacher 模型 pin 死；数据离线固定 |
| 扩产对象 | 采样轮数（贵、慢、方差大） | **数据集行数**（可并行、可版本化） |
| 泛化证据 | 收敛曲线（易被奖励塑造污染） | held-out 组合成功率 × 数据量曲线 |
| 可控性 | 训练过程不可回滚 | 数据/模型/验收全版本化，可回滚 |

结论：规模化的瓶颈从"探索"转移到"数据基建"——这正是本路线的投入重点。

---

## 2. 总体架构（数据飞轮）

```
世界定义(world)                    任务生成(gen)                可执行验收(verify)
operator repertoire + grammar  →  plan + inputs + NL instr  →  checker(只看公开产物)
        │                                  │                            │
        │                                  ├─ public spec ─────────────►│
        │                                  └─ hidden gold plan          │
        │                                            │                   │
        │                                  teacher(oracle/search/llm) ───┘ 只保留 verify 通过的轨迹
        │                                            │
        │                                  data store (content-addressed, versioned, split, audit)
        │                                            │
        └────────────► runner(graph × controller × acceptor) ◄── controller(可微 numpy 策略)
                                   │                                   ▲
                          失败轨迹 → hard-negative/DAgger 修正 ─────────┘   (飞轮闭合)
```

关键分离（防循环论证）：

- `gen` 产出两半：**public**（instruction / initial state / expected / 候选动作集）与
  **hidden**（gold plan）。
- `verify` 只吃 public + 产物，独立判定；**import 不到 gold**。
- `controller` 输入只用 public 派生特征；训练时 target 来自 hidden（teacher），
  推理时不可见。
- 对抗测试：验收器必须拒绝全部"错误产物"（含故意做对的假证据）。

---

## 3. 世界层：算子库 + 组合文法（纯程序化打底，零 LLM）

### 3.1 typed-state 与算子契约（唯一口径 = B.1 / B.2）

`state` 保留字段与类型推断见 **B.1**；契约形状以 B.2 为准：

```typescript
interface Contract {
  id: string;                           // 节点 id（唯一口径，别处不复制字面量）
  kind: "op" | "terminal" | "decoy";    // op 入骨架采样池；terminal 仅收尾追加；decoy 只做干扰
  requires: Record<string, string[]>;   // {字段: 允许类型集合}；字段须存在且类型命中
  when?:    Record<string, unknown[]>;  // 值约束；缺省必须按 {} 处理，禁止直接 .items()
  provides: string | null;              // 成功写入的唯一产物字段（验收通道收口）
  out_type: string;                     // 成功后 provides 字段的类型（TYPE_LIST 之一）
}
interface GraphNode extends Contract {
  alive: boolean;                       // 图实例运行期标记：false = 本轮不可选（干扰/下线）
  requires_types: string[];             // = requires 允许类型并集去重，由实现派生，非契约真源
}
```

> `NODES` 含 `entry`/`exit` 两个无契约结构节点；`ROUTING = sorted(NODES − {entry})`。
> `enumerate_skeletons` 只取 `kind=="op"`，`candidates` 额外用 `alive` 过滤，`featurize_action`
> 读 `kind/provides/requires_types/out_type`——三处口径都来自本处，别处不得再自建字段。

算子 = 图节点：`run(state) -> state | null`（`null` = 死路），确定性、可执行；成功必须把
`op_id` 追加进 `state.hist`。契约先行：选边后、执行前查 `requires/when/provides`，
不满足 = **零代价死路**；禁止把整个 state dump 给 LLM。

### 3.2 算子库（v0 唯一真源 = 附录 B.2，23 节点）

**Phase 0 只许实现 B.2 表内的节点**。下列更广的类型是**路线图，禁止 Phase 0 实现**，
也禁止进入骨架枚举：集合（`sum/sort/unique`）、转换（`int_to_str/str_to_int`）、
文件 IO（`save_file/read_file`，且 IO 只能在适配器）、正则/JSON 等。

### 3.3 组合文法与任务生成（唯一口径 = C.1）

- **骨架** = 类型合法的算子序列（不含终算子）：先 `enumerate_skeletons` 全枚举，
  再按 `(深度 × 是否含 cond)` **分层采样与分层切分**，最后按族补 `submit`(+`check_*`)。
- 深度上限 `MAX_DEPTH=5`；同算子重复受 `MAX_REPEAT=2` 限制。
- `expected` 由回放求出（不由人手写）；`cond_*` 已原子化（自带谓词），世界无裸谓词/`pred`。
- **两条风格**：`follow`（指令=配方线性渲染，考核解析+组合泛化）与 `goal`（指令只给目标
  属性、多解可接受，考核真正的编排/组装）。实验主指标放在 `goal`，`follow` 作解析基线。
- **组合 held-out**：held-out 的是**算子骨架**（未见过的组合），不是任务字符串——
  对应记忆里"预训练目标 = 覆盖度 + 组合能力（用零件现场组装正确路径）"。

### 3.4 难域注入（对齐"单角色必失败"）

部分任务验收要求 **≥2 个不同生产者的产物**：
内容通道（`answer`）+ 确定性检查器产出的 `verdict` 通道（v0 即 `verdict`；代码族若另开通道
再在 B.2 增列，禁止别名歧义），且 verdict 只能由检查器节点 `provides`，规划器/生成器无法直接写。
对齐记忆：`engine.evaluation.acceptance_must_be_channel_restricted`。

---

## 4. 验收层：可执行、通道收口、抗投喂

- `verify/acceptor.ts`：唯一签名以 **B.4 `accept(task, state)`** 为准（本节不另立第二份签名）。
  - 值判定：`family="value"` 与独立重算的 expected 比对；
  - 目标判定：`family="goal"` 按公开目标谓词 `goal_ok(answer, spec)`；
  - 复现判定：产物是代码时在沙箱里跑测试并取真实返回码（Phase 3）。
- `verify/sandbox.ts`：子进程 + 墙钟超时 + 独立临时工作区；确定性；不联网（禁
  `urllib/socket`）。资源硬限为 POSIX-only（`resource` rlimit：CPU/内存/文件大小），
  Windows 以超时兜底，**不假装有内存硬限**。
- **通道收口**：验收只读本族 `provides` 字段；错误生产者喂不饱验收
  （修 GraphLab 暴露的 translate/code 可被随手产物喂过的缺陷）。
- `verify/adversarial.py`：错误产物套件（空值、类型对语义错、旧 verdict 复用、
  直接复述原题、硬编码常量），**必须 100% 被拒**；随机 fuzz 验收器。

---

## 5. Teacher 层：三级，全部经 verify 过滤

1. **Oracle（Phase 1）**：从 hidden gold plan 生成逐步 `(observation, target_action)`。
   零 API、无限量，是 BC/SFT 的主标签。
2. **Search**：**作为 QA/G2.2 工具 Phase 1 即跑**（穷尽版，见 C.4）；**作为标签源 Phase 2+ 门禁**
   （理由为标签口径，非成本）。Phase 1–2 不进训练集；其"修正动作"也不喂 DAgger。
3. **LLM teacher（Phase 3）**：前沿模型读 instruction 出 plan，**只有验收通过才留**；
   提供"自然语言 → 计划"轨迹，是 sim2real 与 LLM-SFT 对照臂的标签源。**走 Kilo 网关免费档
   （匿名，边际成本≈0，见附录 F.5）**，不是成本受限项。teacher 模型每次 run **pin 死**
   （对齐记忆：fallback 换模型 = 转移函数漂移）。失败时把**公开 verdict 的原因码**回喂做
   **有界修复回环**（≤2 次重试，run 内 pin 不变；仍不过则丢弃）——只回喂公开检查器结论，
   不接触 gold，把"纯拒绝"变成"过滤 + 修复"，提高免费档配额下的轨迹产出率。

轨迹记录 schema（`schema.ts`）：

```
Trajectory {
  task_id, task_hash, world_version, generator_version, acceptor_version,
  style: follow|goal, family: value|verify|goal|goal_verify,
  observation: {instruction, state_snapshot, candidate_actions, action_space_digest},
  step_index, action, done,
  teacher: {kind: oracle|search|llm, model_pin, plan_id},
  verdict: {passed, checker, evidence_hash, channel},
  split: train|val|heldout, composition_id,
  provenance: {seed, ts, code_hash}
}
```

---

## 6. 数据基建（本路线最大投入）

`data/`：

- **内容寻址存储**：append-only JSONL 分片；记录含稳定 content hash；索引按
  `(world_version, split, family)`。**两级去重，口径唯一**：任务级用 C.1 六元组
  `(style, composition_id, instruction, x, expected, plan_hash)`；轨迹步级用
  `(task_hash, step_index, observation, action)`（含 `task_hash` 才能避免跨任务误并，且
  `task_hash` 不含 plan，故步级去重不替代任务级 `plan_hash`）。
- **全员版本化**：world/算子库 hash、generator、acceptor、teacher pin、controller
  code hash、**签名探针集 hash**（`PROBE_INT`/`PROBE_STR`，去冗余与 G2.2 的共同口径）
  全部进 `manifest.json`；数据集快照 = manifest → 可复现、可回滚。
- **切分与泄漏审计**（`splits.ts` / `provenance.ts`）：
  - held-out **≥30/族**；held-out 按**算子组合**切；
  - 泄漏检查：hash 重叠、指令模板重叠、组合注册表命中、gold 是否进特征；
  - 审计不通过 = 该数据集拒发。
- **标签 QA**：抽样把 oracle 标签回放穿验收；同一 observation 出现冲突 action
  （不同 teacher）→ 隔离进 quarantine。
- **安全动作集冲突率**（目标族诊断，`provenance.ts`）：抽样 ≤200 个 on-path 状态，
  用 bounded BFS 判定"除 gold 外仍存在通向验收的动作"的占比——量化多解造成的
  one-hot 标签噪音；Phase 1 起每份报告必报，超阈值（首轮实测校准）才允许在 Phase 2
  门禁内把标签软化为 on-path 状态的动作集分布。
> 待决：「首轮实测校准」有事后挪门槛风险——应在 Phase 1 报告中预注册阈值确定规则
> （如"取首轮 conflict rate 分布的 P75"）而非事后定值，否则软化门禁的预注册性不完整。
>
> **预注册（R3-P1-4，已钉死，勿再改）**：阈值确定规则 = 取首轮统计集 conflict rate 分布的 **P75**，
> 预注册于 Phase 1 首份报告（事后定值即违规）。首轮 N=1000 冒烟实测 **conflict_rate=1.0**（抽样 200
> 状态、1 seed，`runs/scale-demo-20260913T072730`）——goal 族多解使 one-hot oracle 标签近乎任选
> （goal routing_acc 0.35 呼应）。按 P75 规则阈值即 1.0，**Phase 2 标签软化门禁的开启条件已满足**；
> 但软化动作仍在 Phase 2 门禁内执行：先以统计集（4×300、多 seed）重测确认，再走「on-path 状态动作集
> 分布」软化（C.5 门禁）。
>
> **软化执行（2026-09-15，Phase 2 门禁内）**：① 统计集（4×300、5 seed）重测确认通过
> （`runs/soften-confirm-20260915T002858/`：rate 1.0/1.0/0.995/1.0/1.0，dip 全可归因
> BFS 截断保守计数）。② 落地：`data/conflict_bfs.safeActionSet`（值域去重 + 首步动作集 +
> 到最近验收态最短剩余步数深度）；oracle 目标族每步附 safeTargets/safeDepths（gold 强制并入）；
> records.bin v3→v4（targetMask + targetDepths 6bit/置位）；arch v5→v6；Python
> `_y_from_mask` 按深度倒数加权重建软目标（**口径修正实证**：均匀软化冒烟 goal 10k S=0.29
> 回退 < 基线 0.55，弃均匀改深度倒数）。③ 冒烟 {1k,10k}×3（depth 加权）：S_goal 1k 0.4733 /
> 10k **0.6233** vs 基线 0.4437/0.5500（10k +0.073），S_follow 持平 1.0——冒烟达标。
> ④ **全量复评 {1k,10k,30k}×5 未完成**（`runs/scale-20260915T081551-soften-full/` 已产
> 1k×5 + 10k×4，无 results.json）；下一步 = 重跑 30k 软化全量并回填 S_follow/S_goal 对照
> 与 G1.2 判定。
- **失败语料**：控制器失败 rollout 存为诊断语料（偏离步分布、偏离条数、失败族）；**只有状态
  恰在 gold 前缀上的偏离**才可作 on-path 修正标签（老师干预后续跑，可收多条、上限
  `maxFixes`），由 TS `runner/dagger.ts` 生成（E.13）。
- **稀疏编码只在派生层**：`records.jsonl` 存原始 obs（紧凑、可读）；TS `featurize` 产出的
  `records.bin` 才用 `{idx,val}` 稀疏 float32 + 候选位掩码（C.6/F.2）——若把稠密
  `OBS_DIM≈732` 维特征写进 jsonl，30k 轨迹会涨到 GB 级。
- **持久资产存原始 obs**：records 存 instruction/state/hist/候选/target 原值，特征为 TS 侧
  派生的 `.bin` 缓存——特征代码改了不必重生成数据（F.2）。
- **并行生成**：任务相互独立，TS 用 `worker_threads`/子进程按分片生成；扩产单位 = 行数。

---

## 7. 可微控制器（TS 推理 + Python 训练，详见附录 F）

- `controller/features.ts`（**唯一特征源**）：instruction 用"逐算子义项显式提及"（C.6）
  + 小 hash 兜底（Phase 1 `HASH_DIM=256`）；state 白名单字段；候选动作契约特征；step/历史。
- `controller/policy.ts`：前向 + `act`（**pointer 式动态候选打分**），读 `weights.json`。
- `controller/train.py`（唯一 Python）：forward/backward/Adam/CE + label smoothing；
  **只做批量拟合**（不含环境 rollout），按 val 早停 + 校准（ECE）。
- `checkpoint.ts`：读写 `weights.json`（float32 扁平数组 + shape + arch 版本 pin）。
- `runner/dagger.ts`：DAgger 编排（只收 on-path 偏离标签；老师干预后续跑，上限 `maxFixes`）。
- `structure/`（**Phase 4，附录 I**）：离线进化「推理策略 DAG」，用生成器 + 可执行验收器
  当适应度，产出**冻结为版本**的图交给 `runner/graph.ts` 与 pointer 路由；不反向改控制器。

**训练课程（Phase 门禁）**：
1. **BC（Phase 1）**：oracle on-path 轨迹离线交叉熵——**唯一 Phase 1 训练信号**。
2. **DAgger（Phase 2，可选）**：TS 编排，老师干预后续跑、收多条 on-path 修正（≤`maxFixes`）；G2.1 仅诊断。
3. **KD / 迭代自训练（Phase 2+）**：门禁理由是**标签口径**（search/LLM 的 off-path 标签与
   on-path oracle 冲突），**不是成本**；须等 BC scaling 曲线确认瓶颈后另立门禁。LLM teacher
   走 Kilo 免费网关（F.5），可用；LLM-SFT 作为 Phase 3 对照臂。触顶且诊断命中「数据覆盖」
   时，**先开自模仿过滤**（自身验收通过的 rollout 入 BC 池，标签=自身动作、纯数据量手段，
   C.5），再开 KD——KD 才是标签口径变化。

---

## 8. 评测（每个报告强制三臂对照）

Arm（**按 style 分别报告**）：① LEXICON 线性解析启发式（中文义项首现顺序，仅 `follow` 族）
② 同架构随机权重 ③ 训练控制器（BC；Phase 2 可选 +DAgger）④（可选）Oracle gold plan（上界）
⑤（可选）在线 REINFORCE 基线（`eval/reinforce.ts`，同环境同预算）⑥ **廉价机制臂
（`ContractRouteArm`，两 style 都报）**：公开声明反向链（契约合法候选内 provides 满足度贪心、
缺边补边，零学习零泄漏）——goal 族廉价中档基线，follow 族对照。

指标：

- 逐步路由准确率 / top-k、端到端 held-out **greedy pass@1**；
- **组合泛化**：held-out 组合成功率 vs 已见组合；
- **数据 scaling 曲线**：成功率 × 训练轨迹数（log-x）——本路线"兑换规模"的核心证据；
- 与 REINFORCE 的样本效率对照（同环境预算）；
- 路径最优性：相对 oracle 的冗余步数；最短路径率；
- 抗投喂：只有正确通道能过验收的成功率；
- 漂移自修复曲线：注入新干扰算子/替换某叶子行为后，重训到恢复所需数据量
  （对齐记忆 `graph.eval_three_gauges`：启发式基线三臂、只用验收通过产物喂信号、
  held-out ≥30/族；主指标以 **pass@1×N scaling 曲线**替代——BC 离线场景对"技能习得曲线"
  的对应物）。

---

## 9. 目录结构（新建，独立树）

```
experiment/DataGraphLab/                       # TypeScript 实验包（除 train.py 外）
├── README.md                    # 定位、命题、运行、结果、局限
├── package.json / tsconfig.json # vitest + tsx；core 纯函数、零依赖
├── schema.ts                    # Task/Trajectory/Step/Verdict/Manifest + 稳定 hash
├── world/
│   ├── types.ts                 # 类型格（含 deepEq）
│   ├── operators.ts             # 确定性算子库 + 契约 + 干扰项 + emod
│   ├── grammar.ts               # 文法门面（re-export lexicon/tokenize/render）
│   ├── lexicon.ts               # LEXICON/GOAL_LEX/GOAL_TEMPLATES（义项唯一真源）
│   ├── tokenize.ts              # tokens / mention_stats
│   ├── render.ts                # render_recipe / render_goal / parse_recipe
│   ├── lexicon_audit.ts         # 义项与往返护栏自检
│   ├── goal.ts                  # Goal 类型 + goal_ok（仅 spec/验收可见，不进特征）
│   ├── rng.ts                   # 种子 PRNG（mulberry32/PCG32）
│   ├── hash.ts                  # hashObj / crc32 / canonicalJson
│   └── version.ts               # world_version = 算子库 hash
├── gen/
│   ├── generator.ts             # 骨架枚举 + 分层实例化 → public spec + hidden gold
│   ├── difficulty.ts            # 课程学习：按 STRATA 浅→深分层调度（唯一实现，C.1.5）
│   └── splits.ts                # 骨架切分 + held-out 骨架注册表
├── verify/
│   ├── acceptor.ts              # 通道收口的可执行验收（只看 public+产物）
│   ├── sandbox.ts               # 子进程/超时/隔离工作区（代码族用）
│   └── adversarial.ts           # 必拒错误产物套件 + fuzz
├── teacher/
│   ├── oracle.ts                # hidden plan → 逐步标签（on-path）
│   ├── search.ts                # BFS 最短解 + verify 过滤（QA/G2.2/公开规划臂）
│   └── llm_teacher.ts           # 可选，前沿 LLM，verify 过滤
├── data/
│   ├── store.ts                 # 内容寻址 JSONL 分片 + 索引 + 去重
│   ├── records.ts               # records.jsonl 原始 obs 读写 + records.bin 派生缓存
│   └── provenance.ts            # manifest / 泄漏审计 / 标签 QA
├── runs/                        # 运行产物（gitignore）：门禁/scale 证据、manifest 快照
├── adapters/
│   └── llm_gateway.ts           # Kilo 网关免费档（唯一 LLM IO；core 零 IO）
├── controller/
│   ├── slots.ts                 # build_node_slots / NODE_SLOT（追加式稳定槽位）
│   ├── features.ts              # obs/action 特征（唯一特征源，写入 records）
│   ├── policy.ts                # 前向 + act（推理）；读 weights.json
│   ├── checkpoint.ts            # weights.json 读写 + arch 版本校验
│   └── train.py                 # 唯一 Python：numpy 训练器（forward/backward/Adam/BC）
├── runner/
│   ├── graph.ts                 # 算子图 + 契约闸 + 拓扑不变量（可由 structure 产出冻结图）
│   ├── rollout.ts               # controller × graph × acceptor，采集 trace
│   └── dagger.ts                # DAgger 编排（老师干预后续跑，收多条 on-path 偏离）
├── structure/                   # Phase 4：受控结构进化（附录 I）
│   ├── genome.ts                # 推理策略 DAG 基因组 + 结构规范形 signature
│   ├── validate.ts              # 类型闸 / 无环 / entry 禁入 / exit 可达 / 访问上限
│   ├── mutate.ts                # 变异算子白名单（先校验后入种群）
│   ├── fitness.ts               # 生成器+验收器三臂适应度（含复杂度惩罚）
│   ├── search.ts                # 有界 EA/beam 结构搜索（预算封顶、需求触发）
│   └── promote.ts               # 接受闸 / 回滚 / 版本化落盘
├── eval/
│   ├── arms.ts  metrics.ts  scale.ts  reinforce.ts   # reinforce.ts = 同预算基线
├── conformance/
│   ├── gen_golden.ts            # 金标生成器（fixtures + docs/helpers.md 同源冻结）
│   ├── helpers_doc.ts           # helper 规格文档生成
│   └── fixtures.json            # 冻结真值；F1/F2/F4 与门禁均 cite 此
├── docs/
│   ├── gates.md                 # G0.1–G0.6 判定脚本规格（T3）
│   └── helpers.md               # 自动生成，勿手改
├── demos/                       # generate_demo / train_demo / scale_demo（TS 编排）
└── tests/                       # vitest：selftest + 对抗验收 + 泄漏审计 + 金标回归
```

> `verify/sandbox.ts`（代码族）与 `adapters/llm_gateway.ts`（LLM）是 **Phase 3** 资产：
> Phase 0–2 的世界无代码族、无 LLM 节点，按 E.2 不提前实现，仅保留接口占位。

**语言（详见附录 F）**：除 `controller/train.*`（Python + numpy）外，全部为 TypeScript；
跨语言只经 `records.jsonl` / `weights.json` 两个文件，附 `conformance/` 固定 fixture 做
F1 前向一致 + F2 往返一致门禁。**可移植的只有零领域词机制**（契约闸、通道验收、pointer
打分、结构校验、MDL 适应度），将来搬进 `ink-ts/engine/src/core/`；`world/operators.ts`、
`LEXICON`/`LEX_OPS_BASE`、`verify/sandbox.ts`（IO）、`runner/dagger.ts`（起 Python 子进程）
等领域/IO 资产留在实验层，**不得进 core**（F.4/I.7）。

---

## 10. 里程碑（每阶段可运行 + 出一份报告）

| 阶段 | 内容 | 交付物 | 落地状态 |
|---|---|---|---|
| Phase 0 地基 | types/operators/goal/grammar/rng/hash；acceptor+对抗套件；schema；骨架枚举+签名去冗余+分层切分；**G0.6 目标可分性冒烟** | `generate_demo` 产 N 任务；selftest 绿；对抗错误产物 100% 被拒；终算子不入骨架；G0.6 目标分类达标 | **已实现**（G0.1–G0.6 6/6：一致率 1、solvable 1(728 任务)、对抗 1(58 例)、泄漏四指标 0、KL 0.019958、top1 0.9612/encoder_iteration=2；vitest 369（Phase 0 收官时点，现 391）；SKELETONS 4199/heldout 829/val 160/不适格 210；wv 6a596090bff1b45a；证据 runs/gates-*） |
| Phase 1 闭环 | oracle teacher；`plan_bfs` 作可解性 QA；内容寻址 store + provenance + 切分/审计；TS 推理 + numpy BC | 首个 scaling 点（follow/goal 各自的 N=1k/10k held-out 成功率 + CI）+ 分 style 三臂对照（goal 含 Planner 上界） | **已实现/闭环**：A.1 全量达成 `runs/scale-20260915T00-a1-full/`（S_follow 0.9990/1.0/1.0、S_goal 0.4437/0.5500/0.7377 全达标且单调）、门禁 14/14（G1.2 monotonicity_checked=1 首次全量证据转绿）、G1.1 绿（follow 0.0000 / goal 0.0000 ≤ 0.05）、F1–F4 绿；R5→R6→R7（v4 桶碰撞 P0→v5）证据链见 §10 R7 复评节；vitest 450/39 |
| Phase 2 搜证 | `plan_bfs` 作 QA/G2.2/规划臂；DAgger 偏离诊断；G2.3 vs REINFORCE；**goal 族标签软化（§6 门禁内动作）** | BFS 召回 100% + G2.2 精确超 oracle 率 + 偏离分布 + G2.3 同预算对照 + 软化复评 | **进行中**：G2.2（0.90→0.825 守卫核销）/G2.1/G2.3 已落地（见 §10 搜证节）；标签软化统计集确认 + 实现（records.bin v4、arch v6）+ 冒烟 {1k,10k}×3 达标（S_goal 10k 0.6233 vs 基线 0.5500）已完成，**全量复评 {1k,10k,30k}×5 未完成**（下一步） |
| Phase 3 Sim2real | LLM 语义叶子 + LLM teacher（验收过滤）；LLM-SFT 控制器对照臂 | 合成→自然语言 held-out 迁移曲线；成本/质量表 | 未开始 |
| Phase 4 可控自进化 | 结构层（附录 I）：需求触发→DAG 变异→类型闸→三臂适应度→接受/回滚；控制器提案→验收闸→回归闸（成功不降）→版本回滚；失败语料飞轮 | 进化 DAG vs 线性种子/随机 DAG 曲线；漂移注入后的自修复曲线；可回滚版本链 | 未开始 |

开工顺序（Phase 0）：`schema.ts` → `world/*`（含 `rng.ts`/`hash.ts`/`goal.ts`）→
`verify/*`（含对抗套件）→ `gen/*` + 确定性与泄漏测试 → **G0.6 目标可分性冒烟**（先于任何
控制器训练）→ `teacher/oracle.ts` + `data/store.ts` + `demos/generate_demo.ts`。

### R4 诊断勘误（2026-09-14，判别实验结论；详细登记见 README「待决」）

C.8 第二跑（grid {1k,10k,30k} × seeds 0–4，`runs/scale-20260913T094845/`）：
S_goal 0.336→0.585→0.775（10k≥0.50、单调 30k≥1k 达标）；S_follow 0.050→0.247→0.300
（<0.80 不达标）；S_heur=0.9833；幂律 S∞ goal≈0.99 / follow≈0.65（CI 上界 0.78<0.80）；
G2.2 完整 held-out follow 120 条实测超 oracle 率 0.90（门禁 4 条筛查小样全命中、如实红）。

判别诊断（trained 30k s0、held-out 600 follow、选点口径，脚本经交叉验证/正负控/混杂控制）：
- **非均匀误差累积**：失败任务首次偏离 53% 落在第 0–1 步；按 goldLen 分组成功率单调崩
  （len3=100% → len7=21%）——「routing_acc^链长」只是数值吻合，不是因果。
- **mod7 效应（稳健，非深度混杂）**：含 mod7 任务端到端 2.8% vs 不含 65.2%，且按
  goldLen 分层后每层内差距 10–40 倍（len6: 0.018 vs 0.627）；58% 的 follow 任务含 mod7。
- **模型错选非真错**：teacher-forced 546 条错选中 442（81%）判出「通向验收」的合法替代
  （`mod7|e:add3/mul2/sub1/neg` 霸榜 = 模算术交换律），**0 条被证明为真错**，104 条预算
  未决（reachesAccept 只 under-report reached、绝不误报，故合法替代为下界、可信）。
- 脚本有效性：passRate/routingAcc 与 scale 报告逐位一致；正控「失败」全为预算截断、
  手动回放 gold 可验收；负控（篡改 expected）0 误报；EXIT 步模型 600/600 选 exit。

结论与决策：
- 「等价重排 → covariate shift → 深链失败」仍为**假说**（未证实），19% 未决未判。
- **决策：执行 A**——`hasShortcut` 极小性守卫从「单算子+收尾」扩为「删任意 1 步回放
  过验收即拒采换 witness」（O(goldLen) 回放，便宜），滤 mod7/cond 恒等冗余；预期
  G2.2 回落、follow 端到端实质提升（非 mod7 组基线 0.65）。实施前不改验收层。
  **✅ 已落地（2026-09-14）**：落地为「单步替换 + 删任意 ≥1 骨架步（真子序列 ≤31 个，
  每次判定 ≤~200 次 applyOp）」；只换 witness 不换骨架池。**复跑结果**：
  - G2.2 完整 120 条 **0.90 → 0.825（99/120）**：命中任务逐条复核删步型/单步替换型
    零命中（两类已清除），残留 99 条全为多算子替换/decoy 组合型；门禁 4 条小样 4/4
    恒红如实报（阈值 0.02 不动）。G0.2/G0.4/G0.5 复跑全绿。
  - scale 冒烟 {1k,10k}×3 seeds（真实 trainer）：**S_follow(10k) 0.247→0.244 无提升**；
    S_goal(10k) 0.585→0.708（3 seeds 噪声区间不作结论）；S_heur 0.9833→0.9817。
  - **结论**：删步守卫改善数据质量（G2.2 回落）但**非 follow 失败主因**——主因是「验收
    只查终值 ⇒ 模交换重排/替换恒合法」（下条待决）。按冒烟判定 follow 无提升 ⇒
    **不跑全量**；held-out follow 可产域 829→749（80 骨架结构性非最小入册，注册表
    580 键 = 420 goal + 160 follow）。
- **登记待决**：验收只查终值 ⇒ 模交换重排恒合法 ⇒ follow「指令跟随」语义要立住，最终
  需在验收/指标层加轨迹约束（Phase 2 独立决策，不在 A 内）——A 落地复跑证实为
  follow 失败主因（残留替换型 82.5% 任务仍存在更短/等长合法替代），下一杠杆按 §7
  课程序为自模仿过滤。

### R5 轨迹约束立项（2026-09-14，用户拍板：先轨迹约束，仍不达标再开自模仿过滤作最后挣扎）

**决策与口径（先登记后扩展，唯一真源本节）**：

1. **仅 follow 族（value/verify）**：`spec` 增公开字段 `trace`（= 含收尾终算子的渲染
   序列，机读指令规格）；验收 = 原判定 ∧ `deepEq(hist, spec.trace)` **精确匹配**。
   goal 族（goal/goal_verify）不变——多解合法，不设轨迹约束。
2. **合规性**：`trace` 属公开 spec 面（与 `parity`/`length`/`goal` 同层），验收器
   "只看 public + 产物"红线不变；控制器特征白名单不含 spec（G0.4 审计继续钉死，
   无 G0.6 struct 例外），`trace` 不进特征。follow 的考核语义即"按公开序列执行"，
   `trace` 是机器可读的指令规格（instruction 就是它的渲染），**不是 hidden gold
   泄漏**——§2 关键分离只约束"控制器特征不含生成器内部 id"，序列本身属任务规格。
3. **预期连锁（登记口径）**：
   - G2.2（超 oracle 率）**定义性归零**：`plan_bfs` 解必须等于 `spec.trace` 才过验收，
     "严格更短"按定义不存在；
   - `hasShortcut` 对 follow 按定义恒 false（其内部捷径自带不同 trace → 验收拒）
     ⇒ **保留代码作安全网，不再滤任务**；`followUnproducible` 同步退化（无捷径恒真）
     ⇒ **follow 可产域恢复 829 级、held-out 覆盖集与不可产注册表按新口径重生成**
     （580 键 → 仅 goal 侧 420 键，follow 键清空）；
   - follow 数据**全量重生成**（generator/acceptor 版本变化，manifest 记录），goal
     数据保留；
   - `S_heur` 行为不变（弱词法扫描不读 spec.trace，按义项首现序选 → 渲染序即解序，
     语义上界≈0.98）。
4. **A.1 差额条款适配（预注册，先于任何实测）**：`S_follow(10k) − S_heur ≥ 0.05`
   在新语义下**结构上不可满足**（S_heur 弱扫描按渲染序选、上界≈1，trained 增益空间
   理论 ≤ 1 − S_heur ≈ 0.02 < 0.05）——同 R3-P1-1 先例（启发式臂结构上不可满足时
   修订臂/口径而非挪阈值）。**预注册修订**：差额条款从门槛降为**报告列 + 失败集
   重叠诊断**（trained 失败集应 ⊆ 弱扫描失败集 + 深链尾部，不允许在弱扫描成功任务
   上系统性失败）；主门槛 `S_follow(10k) ≥ 0.80` 与单调性**不动**。显式标注 benchmark
   语义变化，不静默替换。
5. **顺序（用户拍板）**：轨迹约束落地复评；若 `S_follow` 仍不达标 → 开**自模仿过滤**
   作最后挣扎——此时验收已含轨迹约束，"自身验收通过的 rollout" 必符合指令序列，
   自模仿过滤的偏离强化风险消除，回归纯数据量杠杆（§7）；KD 仍在其后（标签口径变化）。
6. **风险登记**：深链误差累积（len7 组 21%）不因约束自动消失——约束消除的是标签
   噪音（模交换替代不再合法），非表示/容量瓶颈；若约束后仍触顶 <0.80，三分诊断
   剩余项为"表示容量/数据覆盖"，届时按上条顺序推进。

### R6 词法顺序槽特征（2026-09-14，用户判断 + 分层诊断证据：表示瓶颈，非容量/数据覆盖）

**R5 复评（冒烟 {1k,10k}×3，`runs/scale-20260914T12-r5-smoke/`）**：follow trained
1k≈0.021 / 10k≈0.201（R5 前 0.050/0.244，**不升反降**）；S_heur=0.975；goal 10k=0.599
正常。轨迹约束正确消除标签口径噪音（G2.2 归零、对抗闭环）但**非达标手段**——暴露
真实瓶颈为表示层。

**分层诊断（`scripts/follow_diag.ts`，trained 10k s0–s2，统计集 600 follow）**：
- A. goldLen 分组：len3=0.75→len4=0.55→len5=0.35→len6=0.17→len7=0.10 单调崩；
- B. 含恒等冗余步（原 80 骨架近似）：0.128–0.145 vs 不含 0.197–0.228（差 ~7 点，
  数据覆盖有贡献但非主因）；
- C. **步位路由：step0=0.78–0.83、step1=0.68–0.74、step2/3≈0.73**、step4≈0.89、
  step5+=1.0——首步（纯读指令、无历史）即有 ~20% 错选，第二步更差；弱扫描首步
  100%。模型特征只有每算子独立的命中/首现/全局 rank，**无指令内多算子相对顺序
  编码**，排序比较对小 MLP 不可分；
- D. **失败集重叠：trained 失败 490 条中 478（97.5%）弱扫描成功**——模型失败的
  几乎全是 0 参数启发式能对的任务 ⇒ 任务可解、信息在指令词法层、模型没吃到。

**结论**：表示瓶颈（词法顺序信息缺失）。排除容量（0 参数弱扫描 0.975 碾压 105k
模型 ⇒ 信息不在特征里，**跳过 H 256 容量旋钮**，C.6 预注册顺序中"区分容量与表示"
的证据已齐）；数据覆盖（B）非主因，自模仿过滤按序押后。

**决策与口径（唯一真源本节）**：
1. **词法顺序槽**（`lang` 特征集 v2）：`featurizeInstr` 增 `ORDER_SLOTS=8` 个顺序
   槽位，按"义项首次出现位置升序"（与 HeuristicArm 同源口径：`mentionStats` 的
   first、并列按 `LEX_OPS_BASE` 固定序 tie-break）逐位 one-hot 算子
   （`ORDER_DIM = 8 × 15 = 120`）；OBS_DIM 732→852，ACT_DIM 不变；arch 版本
   bump **v2**（特征语义变化，F.2 fail-fast 生效；`hash_only` 消融删段含顺序槽，
   OBS_DIM 671 不变）。
2. **合规性**：顺序槽只从公开 instruction 派生（复用 mention_stats 首现口径），
   零泄漏（G0.4 审计继续钉死）；goal 族指令无算子义项 → 顺序槽恒零（goal 走
   GOAL_HINT/NUM 通道，不受影响）。
3. **预期**：首步 0.78→0.95+；模型在顺序槽上学习**类型消歧**（弱扫描不做）——
   "取反"并列槽位模型可学选 reverse（Str 状态）而非 neg ⇒ `S_follow − S_heur`
   差额条款（R5 已降为报告列）有机会转正，即 A.1"歧义消解+组合增益"的语义通道。
4. **判定**：冒烟 {1k,10k}×3：routing_acc 首步 ≥0.95 且 S_follow(10k) > 0.40
   （较 0.201 实质提升）→ 全量 {1k,10k,30k}×5 复评 A.1（S_follow(10k) ≥ 0.80）；
   仍不达标 → 按序转自模仿过滤（数据覆盖杠杆，R5 后安全）。
5. **风险登记**：并列义项槽位 tie-break 与弱扫描同源——模型可能复制弱扫描的
   tie-break 错误（取反→neg）；缓解：并列位置两算子都进 hash/mention 冗余信号，
   模型有偏离通道（记录为已知简化，不预置多热编码）；深链误差累积不因特征修复
   自动消失，最终水平由每步精度 × 链长决定。

### R7 进度对齐槽特征（2026-09-14，R6 复评证据：顺序槽方向正确但不到位，缺口在「顺序槽全局位置 ↔ 历史进度」的对齐）

**R6 复评（冒烟 {1k,10k}×3，`runs/scale-20260914T22-r6-smoke/`）**：S_follow(10k)
均值 0.238（s0/s1/s2 = 0.247/0.238/0.230，R5 0.201 有实质提升但远未达标）；首步
路由 0.78–0.83 → **0.877–0.882**（+10 点，方向正确）——但 **step1–3 只有
0.74–0.75，比 step0 低 13 个点**（`scripts/follow_diag.ts` 步位路由）；失败集仍有
~74% 与弱扫描（0.975）不重叠；含恒等冗余步任务组差 ~11 个点。⇒ 模型无法对齐
"顺序槽全局位置 ↔ 历史进度"（要自己学"hist 里已执行的算子跳过、选下一个未执行"
的两步推理，H=128 MLP 做不到），端到端提升未转化。

**决策与口径（唯一真源本节）**：

1. **进度对齐槽**（`lang`/`struct` 特征集）：obs 新增**「下一个待执行算子」
   one-hot 15 维**（`NEXT_OP_DIM = LEX_OPS_BASE.length`，段位紧随指令段之后、
   段序冻结）。派生源 = 逐位置义项命中组（公开 instruction，`occurrencePlan`
   唯一实现：**枚举义项全部命中位置**升序——同一义项重复渲染 → 重复占位，同一
   位置共享义项同组、组内按 LEX_OPS_BASE 序）`+ obs.hist`（公开）——
   **hist 按序逐次消耗匹配位置**（组内任一算子命中即消耗该位置；decoy 等非序列
   算子不消耗），取第一个未消耗位置、按 LEX_OPS_BASE 序编码组内最小算子（与
   弱扫描同源口径）；历史耗尽（已全部执行）→ 该段全零（此时应选 submit/check/
   exit，模型靠原特征）；goal 族指令无算子义项 → 恒零（goal 走 GOAL_HINT/NUM
   通道，不受影响）。OBS_DIM 852→867（lang/struct 基座）、struct 满宽 860→875、
   `hash_only` 不变（671）；arch 版本 **v4**（F.2 fail-fast 生效）。
   **复评修正（代码纪律级审查，v3 未训练未发布、无证据污染）**：初版按 op
   身份去重跳过（与 R6 顺序槽同用 rankOrder），**重复算子计划步与 oracle 标签
   冲突**——68.6% 骨架（2879/4199）含重复算子、14.7% BC 记录（3483/23652）
   逐步冲突（如 `[add3,add3,submit]` 的 step1 槽位指向 submit 而标签是 add3，
   槽位诱导提前提交/指向错算子）；修正为 occurrence 指针语义（上条：义项全
   命中枚举 + hist 按序消耗），并列义项组内任一算子执行即消耗该位置（初版下
   `取反` 执行 neg 后槽位误指 reverse）；arch v3→v4（dims 不变）。**修复后
   全量验证**：train 池 3052 步逐步比对仅 17 步冲突（0.557%），全部为登记的
   并列义项 tie-break 简化（`reverse<-neg`，弱扫描同源，模型经 mention/hash
   偏离）；重复算子步与终算子续步（submit→check）零冲突。
2. **合规性**：只读 instruction + obs.hist 两个公开面，零泄漏（G0.4 审计继续
   钉死）；`trace`/`plan_hidden` 仍不进特征。进度槽把弱扫描"按义项序逐步执行"
   的**当步选择**直接暴露成特征——模型可复制弱扫描行为（上界 ≈0.98 的可达
   通道），同时仍可经 mention/hash 冗余信号偏离（并列义项类型消歧 = A.1
   差额语义通道），不做多热预置（同 R6 风险登记）。`weakLexicalPlan` 已统一
   走 `occurrencePlan` 单一实现（含重复算子后 S_heur 理论微升；统计集 600 条
   实测仍 0.9750，冒烟复测如实报告）。
3. **预期连锁**：step1–3 路由追平 step0（对齐推理不再由 MLP 现学，重复算子步
   不再被槽位误导）；S_follow(10k) 冒烟目标 > 0.40（较 0.238 实质提升）；
   首步 routing_acc 维持 ≥0.90 作晋级诊断列（R6 未达 0.95 口径），主判据为
   S_follow。
4. **判定**：冒烟 {1k,10k}×3：**S_follow(10k) 均值 > 0.40** 且首步路由 ≥0.90 →
   全量 {1k,10k,30k}×5 复评 A.1（S_follow(10k) ≥ 0.80）；仍不达标 → 按序转
   **自模仿过滤**（数据覆盖杠杆，R5 后验收已含轨迹约束，安全）。
5. **风险登记**：进度槽把弱扫描的当步选择暴露给模型——若弱扫描在该步有错（并列
    tie-break 类型误判），模型大概率复制；缓解同上（mention/hash 冗余偏离通道）；
    恒等冗余步（B 组差 ~11 点）不因进度槽自动消失（弱扫描在该任务上也按序执行），
    属数据覆盖项，若进度槽达标后仍触顶再按序开自模仿过滤；深链误差累积仍由每步
    精度 × 链长决定。

### R7 复评（2026-09-14，冒烟证据 + P0 动作哈希桶碰撞修复）

**冒烟 {1k,10k}×3（arch v4，`runs/scale-20260914T23-r7-smoke/`）**：S_follow(10k)
三 seed 全 = 0.4200（N=1000 亦 0.4200；S_heur 0.9750）；首步路由 0.8900（判定线
0.90 未达）；step1–3 = 0.8433/0.8633/0.8356（R6 0.74–0.75 实质提升但未追平 step0）；
step4+ ≥0.92；失败集 348/600 全部落在弱扫描成功任务上（D 重叠：trained 失败且弱
扫描也失败 = 0）。

**关键证据（P0）**：三 seed 行为**逐位一致**（step0 动作 600/600 相同、1k/10k 同值，
权重文件间 diff 达 0.7 量级）→ 结构性结果而非学习噪声；逐步分解 step0 错例 66/66
全为 `gold=mod7` 且一律错选 add3，其余 10 个算子 100% 命中（slot==gold 595/600，
被忽略的是 mod7 槽位）。

**根因**：动作特征哈希桶 `crc32(id)%64` 碰撞 **bucket=51: [add3, mod7]**，且二者
契约全同（kind=op、provides=x、Int→Int）→ 动作特征**逐位相同** → 指针得分恒等 →
softmax 并列、贪心按候选序（ROUTING 排序 add3<mod7）恒选 add3 → **mod7 结构性不可
学**（对任意 obs 都是 50/50 且 tie-break 恒输；R5/R6 期已存在，被其他误差掩盖）。
另两处碰撞 [neg, fake_add]/[append_bang, noop] 因 kind/类型位不同不构成全等。

**修复（唯一改动点 controller/features.ts）**：动作桶改「同签名类内无碰撞」分配
（类 = kind+provides+requires_types+out_type；类内线性探测，其余节点桶位 = 原
crc32 基位不变；64 桶 > 22 节点可行）。**arch v4→v5**（特征语义变化，F.2
fail-fast 生效，旧 v4 权重禁载）；回归测试钉全 ROUTING 动作特征两两不同 +
add3≠mod7；fixtures f1/f2 重生成（dims 不变 867/83，权重同 seed 不变）。

**判定（修复后重跑冒烟 `runs/scale-20260914T23-r7b-smoke/` 作 R7 正式判定）**：
**达标**：S_follow(10k) 均值 = 1.0000（1k/10k × 3 seed 六格全 1.0000，600/600），
首步路由 = 1.0000（≥0.90 达成；分层诊断全 step 1.0000，含 len7 深链组与恒等冗余步
组，深链误差累积随槽位链同步归零）；routing_acc 全步 1.0000；S_heur = 0.9750 不变
（弱扫描自身 2.5% 失败集中在并列义项 tie-break 类型误判——trained 反超弱扫描，
`S_follow − S_heur = +0.0250` 首次转正，A.1 差额语义通道（歧义消解+组合增益）兑现，
报告列如实正）；goal 不受影响（10k ≈ 0.56，与历轮同量级）；门禁 14/14 全绿（G1.2
首次转绿：S_follow(10k)=1.0000 ≥ 0.80，S_goal(10k)=0.5611 ≥ 0.50）。
**晋级全量复评**：按 R7 §4 → 全量 {1k,10k,30k}×5 复评 A.1（主门槛 S_follow(10k)
≥ 0.80 与单调性判定；30k 行新增为单调性判定、10k 行保留为 G1.2 连续性）。

**全量复评（2026-09-15，`runs/scale-20260915T00-a1-full/`，arch v5，A.1 达成）**：
S_follow trained pass@1 = 0.9990 / **1.0000** / **1.0000**（1k/10k/30k，跨 5 seed；
10k/30k 五 seed 全 600/600；routing_acc 0.9999/1.0000/1.0000）；S_goal =
0.4437 / **0.5500** / **0.7377**（≥0.50 且单调）；S_heur = 0.9750 不变；
`S_follow − S_heur = +0.0250` 报告列首次转正（A.1 差额语义通道兑现）。
**G1.2 主门槛（monotonicity_checked=1，首次全量证据转绿）**：S_follow(10k)=1.0000
≥ 0.80 ✅；S_goal(10k)=0.5500 ≥ 0.50 ✅；单调性 S_goal(30k)=0.7377 ≥ 1k=0.4437 ✅
且 S_follow(30k)=1.0000 ≥ 1k=0.9990 ✅。k% 覆盖副轴（coverageN=1000）：follow
0.9886/0.9944/0.9869/1.0000（k=10/25/50/75），goal 0.5254/0.4717/0.4732/0.4030。
门禁 14/14 全绿。复评闭环；后续杠杆（自模仿过滤/KD）按课程序仅在超 oracle 判据或
新目标评审时触发。

**G2.3 REINFORCE 同预算对照（Phase 2 搜证，2026-09-15，`runs/phase2-g23-20260914T232039/`）**：
白手起家随机初始化、单遍采样 budgetSteps=BC N×8=80000 → reinforce.bin →
`train.py --loss reinforce`（5 epoch、β_ent=0.01、lr=1e-3）→ held-out 评测。采集
10246 rollouts / 80011 env 步 / 174 解决（meanReward 0.0170）/ 80011 行；训练 785 batch。
**结果**：S_follow REINFORCE=0.0000 vs BC=1.0000（精确轨迹、随机 0 解决 ⇒ 零信号，
RL 完全失败）；S_goal REINFORCE=0.3617 vs BC=0.5700（多解 goal 给随机 1.7% 命中 ⇒
微弱信号，RL 学到 BC 的 ~64% 但仍 < 密集监督）。**预注册解读（§10 G2.3 行）**：同
预算样本效率对照，稀疏终局奖励下 RL 不及密集监督 BC；赢/输按效率报告，禁止升格为
路线裁决（§0 信号稀疏/信用分配不因本玩具域结果存废）。

**G2.1 DAgger 偏离诊断（Phase 2 搜证，2026-09-15，`runs/phase2-g21-20260914T233614/`）**：
从 BC s0（oracle 基 57357 行复刻）起步、3 迭代 × 2000 任务 × maxFixes=4。
**偏离分布**：deviatedRollouts 3006/6000（50.1%）、deviatedSteps 9003；首次偏离
步位直方图 k0:2270 / k1:578 / k2:126 / k3:27 / k4:4 / k5:1（75.5% 首步、94.7% 前
两步，goal 首步路由为最大偏离点）；rowsAdded [1938, 2728, 2890]。
**held-out 差**：goal DAgger=0.5800 vs BC=0.5700（+0.010；iter 内 0.6350/0.5350/
0.5800 不单调，修正不复合）；follow 双侧 1.0000 无偏离无增益。**预注册解读（§10
G2.1 行）**：诊断项不作晋级门槛——首次偏离之前未经过的 off-path 状态始终无监督，
增益有限属结构预期。

**§6 标签软化（Phase 2 门禁内动作，2026-09-15）**：统计集（4×300、5 seed）重测
确认（`runs/soften-confirm-20260915T002858/`，rate 1.0/1.0/0.995/1.0/1.0，dip 全
归因截断）→ 实现 `safeActionSet`（值域去重 + 首步深度）+ safeTargets/safeDepths +
records.bin v4（targetMask+targetDepths 6bit/置位）+ arch v6 + Python 深度倒数
加权软标签。**口径修正**：均匀软化冒烟回退（goal 10k 0.29 < 基线 0.55）→ 弃均匀
取深度倒数。**冒烟 {1k,10k}×3（depth 加权）**：S_goal 1k 0.4733 / 10k **0.6233**
vs 基线 0.4437/0.5500（10k +0.073）、S_follow 1.0/1.0 持平。**全量复评
{1k,10k,30k}×5 未完成**（`runs/scale-20260915T081551-soften-full/` 已产 1k×5 +
10k×4，无 results.json）；下一步 = 重跑 30k 软化全量并回填 S_follow/S_goal 对照
与 G1.2 判定（门禁以最新 `scale-*` 目录为证据）。

---

## 11. 红线与防作弊（全部来自既有失败证据）

1. 验收器只看 public spec + 产物，**永不 import gold plan**；通道收口。
2. 控制器特征不含 gold/生成器内部 id/模板指纹；held-out 按组合切。
   （唯一例外：`struct` 诊断 arch 的公开 `spec.goal` 紧凑编码，见 E.5——不进主臂。）
3. 每份报告必须有启发式基线三臂；`greedy pass@1`，不许图臂多次重试偷分。
4. 统计/偏好按 `(node, provider)` 分开；teacher 模型 run 内 pin 死。
5. 拓扑不变量代码层焊死：entry 禁入、exit 专用弹回边（Phase 4 显式 DAG 后；v0 扁平契约世界 exit 被选即终止，无弹回）、单节点访问数上限。
6. 演化/落盘走版本化与回归闸：新版本成功不降才晋升，否则回滚。
7. 所有 IO 只在 adapters/exec/sandbox；语义核零 IO。
8. **结构进化离线且需求触发**：只有"能力缺口"记录出现才准跑 `structure/search`；
   禁止按时钟/按概率无脑生长（对齐 `engine.evolution.clock_driven_additive_no_rollback`）。
9. **新增/克隆必须带能力增量**；纯 prompt/参数变异不占生长额度；等价结构按 `signature` 去重。
10. **候选 DAG 先过闸再评估**：类型/无环/entry/exit/访问上限不通过 = 零适应度，不进种群。
11. 结构晋升须过接受闸（成功非降 + 熵 ≤ 历史最优 + 复杂度受限），失败回滚；禁止真实域无回滚。
12. **节点自治界外**：Phase 0–3 节点 = 确定性函数或单步 LLM 叶子；禁止节点多步内部执行/
    自选流程（会毁掉 G0.1 确定性、G0.2 回放可解与验收独立重算）。引擎侧自治 = 契约内自治、
    契约外受控（子执行树 + 审批 + 预算 + 审计）；本实验只贡献「选自治单元的路由 + 通道验收」
    半边。

---

## 12. 主要风险与对策

| 风险 | 对策 |
|---|---|
| 生成器与验收器同源 → 共同盲区 | 对抗套件独立于生成器编写；属性/随机错误产物必须全拒；fuzz 验收器 |
| 捷径学习（模板/长度泄漏） | 模板措辞随机化；特征消融审计（删 instruction 看是否崩）；held-out 组合 |
| oracle 天花板 = 生成器计划 | search teacher 发现超计划解；迭代自训练；度量 beyond-oracle 率 |
| 小型控制器容量上限 | 主信息走"逐算子义项显式提及"特征，hash 仅 256 维兜底；若仍触顶即为 LLM-SFT 臂存在的证据，Phase 3 对照 |
| goal 族目标只能从指令反推（`spec` 不进主臂特征） | 已前移为 **Phase 0 硬门禁 G0.6**（公开指令特征下测 `parity/gt/len/all` 分类）；不达标先改编码器，**不改阈值** |
| goal 族 `all` 合取 + greedy + 滚窗历史 → 多步规划缺回溯 | 报告按目标深度/是否 `all` 分层；触顶走"表示容量/数据覆盖/标签口径"三分诊断，不隐藏 |
| sim2real gap 才是真考验 | Phase 3 显式设自然语言 held-out 与真实叶子迁移曲线 |
| 结构进化退化为时钟驱动/无界生长 | 需求触发 + 复杂度 MDL + 成功非降/熵界 + 回滚；违规候选零代价淘汰（§11.8–11） |
| 结构变化作废控制器权重 | I.2 编码不变式：`MENTION` 词表冻结、`hist` 追加式稳定槽位、变长 `cand_mask`、arch 版本 fail-fast |
| 适应度高原 / 中性漂移 / 等价结构重复 | 多样性保留 + `signature` 去重 + 三臂对照；无成功增益即退回更简结构 |
| 结构搜索 hack 验收器 | 对抗套件前置过滤；只用正确通道产物计成功；held-out 组合考核 |
| 数据基建膨胀失控 | 分片 + manifest + 索引先行；runs/ 隔离；每阶段只加一种存储能力 |
| 世界复杂度不足（trained ≈100% 且 random ≤0.05） | A.1 目标非 1.0；`ContractRouteArm`（goal 族中档基线）held-out 上须显著低于 trained、`S_heur` 须低于 trained；若全臂 ≈100%，报告"世界太易"并后续加算子/扩深度/增干扰节点，**禁止据此声称方法优越** |

---

## 13. 与既有记忆/约定的一致性

- 可积累对象 = repertoire（技能+契约+验收门），不是拓扑
  （`engine.evolution.pretrain_objective_repertoire_coverage`）；
- 预训练目标 = 覆盖度 + 组合能力（现场组装正确路径）；
- 验收只许正确通道喂饱；基线三臂 + held-out ≥30/族 + 主指标技能习得曲线
  （`graph.eval_three_gauges`）；
- 契约先行 typed-state，永不整包 dump state 进 prompt；
- 演化带回归闸门（成功非降）与可回滚版本链；结构进化需求驱动、能力增量、成功非降 + 熵界
  （`engine.evolution.controlled_self_evolution`、
  `corrections.engine.evolution.clock_driven_additive_no_rollback`）；
- 工具是叶子/注册表能力，不是被训对象；被训的是控制器/编排
  （`corrections.training_target_not_tools`）；
- 单文件保持小而纯（目标 ≤350 行）；TS 侧核心零运行时依赖（devDeps 仅 `typescript`/`vitest`），
  Python 训练器仅 numpy；IO 收口在 adapters/沙箱，core 语义为 0-IO。

---

# 附录 A — 目标与验收标准（可判定，供次点模型照做）

## A.1 唯一主目标（一句话，可测量）

> 在一个**纯程序化、可执行、零 LLM** 的世界里，用生成器产出的合成数据 + oracle 轨迹
> 训练一个可微控制器（TS 推理 + Python 训练），使**组合 held-out 上的端到端成功率
> （greedy pass@1）随训练数据量单调上升**，并在同一 held-out 上显著优于 random 基线，
> 同时报告与 `PlannerArm` 上界的差距。

**主目标的判定式（Phase 1 结束时必须给出下表全部实测值）**：

| 符号 | 定义 | 首轮目标（可实测后校准，但必须报告真实值） |
|---|---|---|
| `S_goal(N)` | **目标式** held-out 的 pass@1（主指标：真编排） | `S_goal(10_000) ≥ 0.50` 且随 N 单调上升 |
| `S_follow(N)` | **配方式** held-out 的 pass@1（解析 + 组合泛化） | `S_follow(10_000) ≥ 0.80` |
| `S_heur_follow` | LEXICON 弱词法扫描启发式（C.7 口径：非类型感知、同位命中按 `LEX_OPS_BASE` 固定算子序 tie-break）在配方式 held-out 的 pass@1 | `S_follow(10k) − S_heur ≥ 0.05`（歧义消解+组合增益；弱臂结构上不做类型消歧，增益含"消歧"成分——口径与实测见 C.7 注） |
| `S_rand` | 同架构随机权重（两 style） | ≤ 0.05（sanity check，非有意义阈值） |
| `S_planner` | goal 族公开 BFS 规划上界（只用 spec，诊断/上界，非训练信号） | 报告值；`S_goal/S_planner` 用于三分归因，不作门禁 |
| 单调性 | `S_goal(30_000) ≥ S_goal(1_000)`（种子噪声内非降） | 成立 |

> 目标式族是**唯一不能被线性解析白拿**的考核：指令只给目标属性，必须靠 state 路由编排。
> 若 `S_goal` 触顶不达标：**不许改阈值**，报告"表示容量 / 数据覆盖 / 目标可达性"三分诊断。
> 对称地，若 `S_goal(N)` 远超目标（如 ≥0.95 且 `S_rand` ≤0.05）：须报告世界复杂度是否
> 充分（`ContractRouteArm` / `S_heur` 是否同样接近 trained），**禁止据此声称方法优越**。

## A.2 分阶段门禁（每阶段不通过不许进入下一阶段）

| 门禁 | 判定方式（命令 / 断言） | 通过阈值 |
|---|---|---|
| G0.1 生成确定性 | 同 seed 在两个独立进程生成，`task_hash` 列表逐字节相同；TS 用 `makeRng(seed)`、`hashObj` 规范序列化（禁 `Math.random`/`JSON.stringify` 默认序） | 100% 相同 |
| G0.2 生成可解 | 每个 emitted task 的 hidden plan 回放穿验收 | 100% |
| G0.3 验收抗投喂 | `verify/adversarial.ts` 全部错误产物 | 100% 被拒 |
| G0.4 泄漏审计 | `provenance.audit()`：gold/`spec` 不在**主臂**特征（`struct` 诊断 arch 除外，E.5）、held-out 骨架不与 train 重叠 | 0 违规 |
| G0.5 分布对齐 | train/heldout 的 深度×cond 层分布 KL（同源 `STRATA`）+ per-stratum held-out 覆盖率边距报告 | < 0.05；边距仅报告不作阈值 |
| G0.6 目标可分性 | **Phase 0 硬门禁**：只用公开指令特征（`GOAL_LEX`+`NUM`+hash）训线性/同架构分类器区分 `parity/gt/len/all` 目标类别 | 预注册阈值 top1 ≥ 0.90（**固定，禁止事后校准**）；不达标先改编码器，**不许带瓶颈进 Phase 1**。**预注册升级规则**：编码器迭代上限 **M=3 轮**（每轮调一个旋钮：模板措辞/特征工程/hash 维度）仍不达标 → 先试 `lang` 容量旋钮（H 128→256），仍不达标 → 激活 `learned` 诊断臂（C.6）复核表示上限；若 `learned` 也不达标才把 `struct` 提为并列主臂并在报告显式标注 benchmark 语义变化，**禁止静默替换主臂掩盖 A.1** |
| G1.1 非免费午餐 | random 臂 pass@1（两 style） | ≤ 0.05 |
| G1.2 主目标 | 见 A.1 | 见 A.1 |
| G1.3 三臂齐全 | 每份报告含 heuristic(follow) / random / trained；goal 另含 planner 上界 | 缺一不可 |
| G2.1 偏离诊断 | DAgger 臂的偏离步分布/条数 + 与纯 BC 的 held-out 差 | **诊断项，不作晋级门槛**（首次偏离之前未经过的 off-path 状态始终无监督，即便老师干预后亦然） |
| G2.2 超 oracle 率 | **仅配方族**：`plan_bfs` 最短解通过验收且算子步数 `< len(gold_plan)`（都不含 EXIT）占比。恒等签名已去冗余时丢弃、follow 族极小性守卫（C.1）已在生成端过滤捷径任务 → 期望≈0；>0 可能是 Str 探针/代数碰撞，或**多算子巧合捷径**（实测存在：极小性守卫只挡单算子+收尾捷径，多算子巧合更短不挡）——阈值不变，非零如实报告作自检证据 | ≤ 0.02 |
| G2.3 击败 REINFORCE | 同环境、同环境交互步数预算下，trained vs REINFORCE 基线 | trained 更高。**预注册解读**：这是**同预算样本效率对照**，不是 §0 命题的可证伪检验（§0 关于真实域信号稀疏/信用分配，不因本玩具域结果存废）；赢/输均按效率报告，禁止升格为路线裁决 |
| G3.1 LLM 过滤纪律 | LLM teacher 轨迹（Phase 3）入训练集 100% 通过验收（pin 死、≤2 修复回环、仍不过即弃） | 100% |
| G3.2 迁移对照 | 语义叶子世界 held-out：trained 迁移曲线 + `LLMZeroShotArm` 同 held-out 对照（同 pin 同模型） | 报告必含两臂，缺一不可 |
| G3.3 成本/质量表 | 免费档轨迹产出率、延迟/限流实测、模型 pin 清单与每次 run 刷新记录 | 报告必含；禁止降级/关闭 LLM（F.5） |

> **REINFORCE 臂训练规格（钉死，保可复现）**：
> - **reward**：终局 `+1`（`accept===true`）/ `0`（否则）；无中间 reward。
> - **baseline**：滑动窗口均值（窗口=最近 200 条 rollout 的 mean reward）做方差缩减；
>   advantage = reward − baseline。**不用 learned value head**（保架构与 BC 臂同构）。
> - **初始化**：**同分布同架构随机初始化**（`U(±1/√fan_in)`、偏置零；TS `Policy.random(seed)`=makeRng+float32
>   舍入，Python `params_from_json(dims, seed)`=default_rng+float64——跨语言 PRNG/精度不同，**不承诺逐位一致**；
>   BC 与 REINFORCE 同在 Python 侧、同 seed 逐位一致即可）。不从 BC checkpoint 热启——
>   热启会把 BC 的 imitation bias 带进 RL 对照，污染「RL 白手起家 vs BC 离线监督」的对照语义。
> - **lr/batch**：`lr=1e-3`（比 BC 的 3e-3 低，因 REINFORCE 梯度方差更大）、`batch=512`、
>   无 cosine 衰减（REINFORCE 无 val 早停，固定 lr + 总步数预算封顶）。
> - **entropy bonus**：`β_ent=0.01`（防过早坍缩到贪心策略）。
> - **预算口径**：BC 臂训练集总步数 `≈ N × 8`（N 条任务 × ~8 步/任务）= REINFORCE 臂的
>   rollout 总步数上限；超预算即停。两端均 `greedy pass@1` 在同一 held-out 统计集上评测。
| G4.1 回归闸 | 新版本重训后 held-out 成功不降，否则回滚 | 成功非降 |
| G4.2 结构有效性 | `structure/validate` 对全部候选 DAG：类型闸 / 无环 / entry 禁入 / exit 可达 / 访问上限 | 100% 通过，违规候选零适应度 |
| G4.3 结构进化增益 | held-out ≥30/族：进化 DAG vs 线性种子 vs 同 \|V\|,\|E\| 随机 DAG（同预算） | 进化 ≥ max(种子, 随机)，且复杂度惩罚后仍不劣 |
| G4.4 预算与去重 | 结构搜索种群/代数/节点/调用预算封顶；等价结构 `signature` 重复率 | 超预算即停不晋升；重复率首轮目标 ≤ 0.2（实测后校准） |

## A.3 "完成"的定义

一个 Phase 完成 = ① 门禁全绿；② `runs/<run_id>/manifest.json` 含全部版本 hash；
③ `README.md` 回填实测数字与失败模式；④ 对应 `tests/` 断言可重跑复现。

---

# 附录 B — 世界定义（逐项钉死，禁止自行扩展）

## B.1 state 与类型

`state: dict[str, Any]`，JSON 可序列化。保留字段：

| 字段 | 含义 | 谁能写 | 进控制器特征 |
|---|---|---|---|
| `x` | 当前主值（不断被变换） | 初始生成器 / 单值算子 | ✓ |
| `answer` | 提交的最终答案（**验收通道**） | `submit`；`echo`(decoy) 同样写该字段，但产物必不等于真值、验收默认拒绝 | ✓ |
| `verdict` | 独立检查器结论（**验收通道**） | 仅 `check_*` 算子 | ✓ |
| `hist` | 已执行动作序列（控制器自己的历史） | `apply_op` 追加 | ✓ |
| `spec` | 公开校验/目标（check_* 与 goal_ok 读它） | 生成器写，运行期只读 | **✗** |
| `expected` | 真值（**只存在于 acceptor_view，绝不入 state**） | 不写 | **✗** |

类型推断 `t(v)`：`bool→"Bool"`（**先于 int 判断**）、`int→"Int"`、`str→"Str"`、
`list→"List"`、`dict→"Json"`、`None→"None"`。

> `init_state(x, spec=None)` → `{"x", "answer": None, "verdict": None, "hist": [],
> "spec": spec or {}}`。`apply_op` 执行成功后必须把 `op_id` 追加进 `hist`。
> `obs_snapshot(st)` 只投影 `x/answer/verdict/hist`，**禁止**带上 `spec`/`expected`。
> `style ∈ {follow, goal}` 是 **Task 属性**，不进 state（见 C.1）。

## B.2 算子表（v0，共 23 节点；`kind` 决定是否可入采样池）

**规则**：`kind="op"` 才可被骨架枚举 `enumerate_skeletons` 采样；`kind="terminal"`
（`submit` / `check_*`）**只在 `make_task` 收尾按族追加一次**，绝不入采样池；
`kind="decoy"` 只在图中当干扰项，永不入计划。`check_*` 读 `state["spec"]`（公开目标）。

| id | kind | requires | provides | out_type | 变换 | 采样池 | NL 义项 |
|---|---|---|---|---|---|---|---|
| `add3` | op | `x:Int` | `x` | Int | `x+3` | ✓ | → `LEXICON` |
| `mul2` | op | `x:Int` | `x` | Int | `x*2` | ✓ | → `LEXICON` |
| `sub1` | op | `x:Int` | `x` | Int | `x-1` | ✓ | → `LEXICON` |
| `neg` | op | `x:Int` | `x` | Int | `-x` | ✓ | → `LEXICON` |
| `mod7` | op | `x:Int` | `x` | Int | `emod(x,7)` | ✓ | → `LEXICON` |
| `upper` | op | `x:Str` | `x` | Str | `x.upper()`（仅 ASCII） | ✓ | → `LEXICON` |
| `lower` | op | `x:Str` | `x` | Str | `x.lower()`（仅 ASCII） | ✓ | → `LEXICON` |
| `reverse` | op | `x:Str` | `x` | Str | `x[::-1]` | ✓ | → `LEXICON` |
| `append_bang` | op | `x:Str` | `x` | Str | `x+"!"` | ✓ | → `LEXICON` |
| `str_len` | op | `x:Str` | `x` | Int | `len(x)`（Int） | ✓ | → `LEXICON` |
| `cond_even` | op | `x:Int` | `x` | Int | `emod(x,2)==0 ? x+1 : x*2` | ✓ | → `LEXICON` |
| `cond_long` | op | `x:Str` | `x` | Str | `len(x)>=4 ? x.upper() : x+"?"` | ✓ | → `LEXICON` |
| `submit` | terminal | `x:any` | `answer` | any | `answer=x` | **✗** | → `LEXICON` |
| `check_parity` | terminal | `x:Int` | `verdict` | Str | `pass iff emod(x,2)==spec["parity"]`，写 `"pass:"+hash8(x)` | **✗**（verify 族） | → `LEXICON` |
| `check_len` | terminal | `x:Str` | `verdict` | Str | `pass iff len(x)==spec["length"]`，写 `"pass:"+hash8(x)` | **✗**（verify 族） | → `LEXICON` |
| `noop` | decoy | `x:any` | `x` | any | 原样返回 | ✗ | — |
| `fake_add` | decoy | `x:Int` | `x` | Int | `x+2` | ✗ | — |
| `shuffle` | decoy | `x:Str` | `x` | Str | 循环右移 `crc32(x) % max(1,len(x))` 位 | ✗ | — |
| `dead_end` | decoy | `zzz:Int` | `x` | any | 原样 | ✗ | — |
| `echo` | decoy | `x:any` | `answer` | any | `answer="echo:"+str(x)`（前缀保证对 `value`/`goal` 都不可通过） | ✗ | — |
| `branch_decoy` | decoy | `x:Int` | `x` | Int | `x*x` | ✗ | — |
| `entry` | — | — | — | — | 起点，不可被选 | — | — |
| `exit` | — | — | — | — | 验收终点，可被选 | — | — |

> **`"any"` 通配（唯一口径）**：`requires` 的字段值集合可含 `"any"`，表示"字段存在即可、
> 不限类型"；`requires_ok` 命中 `"any"` 即跳过该字段的类型检查。`out_type` 为 `"any"` 表示
> 产物类型动态（`submit`/`echo` 的 `answer`）。`"any"` **不是**类型格成员，绝不进 `TYPE_LIST`：
> `requires_types` 派生与 `featurize_action` 必须**跳过** `"any"`（不置任何 one-hot），
> 否则 `TYPE_LIST.index("any")` 直接 IndexError。
>
> **`out_type` 唯一来源 = 本表 out_type 列**；op 的 out_type 即变换后 `x` 的类型，
> `str_len` 是唯一的 Str→Int。`entry`/`exit` 是无契约结构节点，不参与 `Contract`/动作特征。
>
> **义项 ≥3 只约束 `kind ∈ {op, terminal}`**；`decoy`/`entry`/`exit` 豁免（无 NL 义项）。
> **义项字面不在本表复制**：唯一真源 = `experiment/DataGraphLab/world/lexicon.ts` 的 `LEXICON`
> （每算子 ≥3、义项间无严格包含、共享义项必须类型可判定；由 `world/lexicon_audit.ts` 与
> `tests/` 守，示例由 `conformance/gen_golden.ts` 冻结）。本表只定 id/kind/契约与类型。
>
> **条件算子已原子化**：`cond_even`/`cond_long` 自己算谓词，`requires` 只有 `x`；世界
> **没有**裸谓词算子、没有 `pred` 字段。这从根上消灭了"谓词被消费/过期/`is_even` 裸出现
> 导致最短路径≠gold"的漏洞（对应 P0-1）。
>
> `check_*` 的 `spec` 目标由生成器依**终值**反推（见 C.1），故任何类型合法骨架恒可 pass。
> **验收仍要求 `answer`（submit 产）与 `verdict`（check 产）两生产者同时成立。**
>
> **模语义铁律（跨语言）**：`neg` 产生负数，Python `%` 非负、JS `%` 带符号。所有取模
> 一律走 `emod(a,m) = ((a % m) + m) % m`，在 `world/operators.ts` 唯一定义；禁止裸 `%`。

**目标谓词（`world/goal.ts`，纯函数，仅供 `family∈{goal,goal_verify}` 的验收）**：

```typescript
type Goal =
  | { kind: "parity"; target: 0 | 1 }        // emod(value,2) === target
  | { kind: "gt"; target: number }           // value > target（Int）
  | { kind: "len"; min: number; max: number }// min <= len(value) <= max（Str）
  | { kind: "all"; of: Goal[] };             // 合取，强制多步规划
function goalOk(value: unknown, spec: { goal: Goal }): boolean
```

> 目标谓词**只进 `spec`（acceptor 可见）**，不进控制器特征；`goal` 的 NL 渲染**不得含
> 任何算子义项**（只描述目标属性），否则目标式族会退化成配方族。
>
> **类型守卫**：`parity`/`gt` 只接受 Int，`len` 只接受 Str；类型不匹配一律返回 `false`，
> 不抛异常、不隐式转换（防 `echo` 等跨类型产物触发未定义行为）。

契约匹配（唯一实现，别处不许再写一份）：

```python
def requires_ok(node, state) -> bool:
    for f, types in node.requires.items():
        if f not in state: return False
        if "any" not in types and t(state[f]) not in types: return False   # "any" = 通配
    for f, vals in (node.when or {}).items():
        if f in state and state[f] not in vals: return False
    return True
```

## B.3 候选动作集（action space 定义，唯一口径）

```python
MAX_REPEAT = 2        # 单节点在一次 rollout 中的访问上限（生成器与 runner 共用同一常量）
def candidates(graph, state, hist) -> list[str]:
    out = []
    for nid in sorted(graph.nodes):            # 排序保证确定性
        if nid == ENTRY or not graph.nodes[nid].alive: continue
        if nid == EXIT:
            out.append(nid); continue
        if hist.count(nid) >= MAX_REPEAT: continue           # 访问上限唯一收口在此
        if requires_ok(graph.nodes[nid], state): out.append(nid)
    return out
```

**不变量（代码层焊死，唯一口径）**：`entry` 永不在 candidates；每步至少含 `exit`；
访问上限过滤**只在这里实现**，runner / search / oracle 全部调用本函数。
骨架枚举（C.1）也必须用同一个 `MAX_REPEAT` 限制同算子重复，否则会生成
runner 判非法的计划（此前 `add3×3` 的冲突即源于此）。

## B.4 验收（唯一口径，只看 acceptor_view + state）

```python
def accept(task, state) -> bool:
    av = acceptor_view(task)                     # {family, expected?, spec?}
    ans = state.get("answer")
    if ans is None: return False
    if av["family"] in ("value", "verify"):        # 配方族：值必须等于 gold
        ok = deep_eq(ans, av["expected"])
    elif av["family"] in ("goal", "goal_verify"):  # 目标族：满足目标谓词即可（多解可接受）
        ok = goal_ok(ans, av["spec"])
    else:
        raise ValueError(av["family"])
    if av["family"] in ("verify", "goal_verify"):  # 两生产者族：还需独立检查器 verdict
        ok = ok and state.get("verdict") == "pass:" + hash8(state.get("answer"))
    return ok
```

`deep_eq`：Int 精确相等；Str 精确；list 逐元素。`goal_ok` 见 B.2 目标谓词。
**禁止**把 `expected`/`spec.goal` 放进 controller 可见的任何结构（见 C.6 特征白名单）。

> **verdict 绑定被检值（两生产者语义闭合，R2-P0-1）**：`check_*` 写 `"pass:"+hash8(x)`（hash8 =
> `hash_obj` 前 8 位），`accept` 要求 `verdict == "pass:"+hash8(answer)`——answer 由 `submit`
> 复制当时 x，合法路径 submit→check 之间 x 不变故恒一致；check 之后再变换 x 的路径，
> 旧 verdict 指纹与交付产物不匹配 → 拒绝（堵 `goal_verify` 族"先 check 后改值再 submit"
> 的旧 verdict 复用）。对抗套件"旧 verdict 复用"按此口径实现。

通道表（`verify/acceptor.ts` 唯一）：
`CHANNEL = {value:("answer",), verify:("answer","verdict"), goal:("answer",),
goal_verify:("answer","verdict")}`。

---

# 附录 C — 关键算法伪代码（照抄实现，不要改语义）

## C.1 生成器：原子算子 + 骨架签名去冗余 + 分层配额 + follow/goal 双风格

> 修正四个致命点：① 终算子绝不入采样池（否则中途 `submit` 使 `answer` 与真值错位）；
> ② 同签名骨架去冗余，使**配方族最短路径 ≈ gold**，否则 G2.2 只是在奖励"忽略指令的捷径"
> （目标族 gold = 传入骨架，多解冗余由 `steps_over_shortest` 度量）；
> ③ 训练/held-out **按骨架切**且**两条采样路径同分布**；④ 新增目标式族，让实验真正考核
> "编排"而非"线性解析"。

**形状语义（跨语言，必须一致）**：
`sample_value(rng,"Int") → rng.randint(-50,50)`；
`sample_value(rng,"Str") → 长度 1–8、字母表 "abcdefgh"（**纯 ASCII**，避免 Python `.upper()`
与 JS `.toUpperCase()` 在非 ASCII 上分歧）`。

```python
# gen/generator.py
MAX_DEPTH = 5
PROBE_INT = list(range(-50, 51))     # Int 全域 101 点：签名去冗余从"探针近似"升级为可证正确
PROBE_STR = ["a", "ab", "abc", "abcd", "abcde", "xyz", "Ab", "aBcD", "hello", "wxyzabc"]
ASCII_ALPHABET = "abcdefgh"

def sample_value(rng, root):
    if root == "Int": return rng.randint(-50, 50)
    return "".join(rng.choice(ASCII_ALPHABET) for _ in range(rng.randint(1, 8)))

def enumerate_skeletons(max_depth=MAX_DEPTH):
    """DFS 枚举类型合法算子序列（kind=="op"，不含终算子）。"""
    out = set()
    def dfs(root, fields, plan):
        if plan: out.add((root, tuple(plan)))
        if len(plan) >= max_depth: return
        for op in OPS:
            if op.kind != "op": continue
            if hist_count(plan, op.id) >= MAX_REPEAT: continue      # 与 candidates 同口径
            if types_ok(op.requires, fields):                       # 与 requires_ok 共用口径（any 兜底，E.4）
                nf = dict(fields); nf[op.provides] = op.out_type
                dfs(root, nf, plan + [op.id])
    dfs("Int", {"x": "Int"}, []); dfs("Str", {"x": "Str"}, [])
    return sorted(out)

def signature(root, skeleton, start_x=None):
    """回放得到诱导函数签名：Int 用全域探针（精确，代数碰撞可证无），Str 用固定探针。
    枚举时按前缀增量携带 `start_x→当前值` 的探针向量，逐算子 O(1) 更新，避免逐序列重放。"""
    probes = PROBE_INT if root == "Int" else PROBE_STR
    sig = []
    for probe in probes:
        st = run_plan(list(skeleton), init_state(x=probe))
        sig.append(None if st is None else (t(st["x"]), st["x"]))
    return tuple(sig)

def dedupe_by_signature(skeletons):
    """同签名只留最短（同长取字典序首）：这是"最短路径 ≈ gold"的关键。"""
    best = {}
    for sk in skeletons:
        key = signature(sk[0], sk[1])
        if key not in best or (len(sk[1]), sk[1]) < (len(best[key][1]), best[key][1]):
            best[key] = sk
    return sorted(best.values())

def is_identity(root, skeleton):
    """恒等签名：全部探针下值不变（如 [neg,neg]、[reverse,reverse]；[add3,sub1] 是 x+2
    非恒等，勘误修正——判定式以全探针值不变为准）。
    不提供任何组合信息，且其任务存在 0-op 解（[submit]）→ G2.2 必超阈值，直接丢弃。"""
    for probe in (PROBE_INT if root == "Int" else PROBE_STR):
        st = run_plan(list(skeleton), init_state(x=probe))
        if st is None or not deep_eq(st["x"], probe): return False
    return True

SKELETONS = [sk for sk in dedupe_by_signature(enumerate_skeletons(MAX_DEPTH))
             if not is_identity(sk[0], sk[1])]
def _skel_id(sk): return hash_obj([sk[0], list(sk[1])])
def _stratum(sk):                                    # 分层键：深度 × 是否含 cond
    return (len(sk[1]), any(op.startswith("cond_") for op in sk[1]))
STRATA = {}
for _sk in SKELETONS: STRATA.setdefault(_stratum(_sk), []).append(_sk)

def _split_maps():
    """每层 heldout≈20%、val≈5%，且**每层保底 ≥1**；层内骨架 <2 直接报错（不静默）。
    两条切分来自同一 STRATA，保证 train/heldout 深度分布一致（G0.5）。"""
    heldout, val = set(), set()
    for st, sks in STRATA.items():
        ordered = sorted(sks, key=_skel_id)
        if len(ordered) < 2:
            raise RuntimeError(f"stratum {st} 骨架不足 2，无法切 train/heldout：请扩算子或降 MAX_REPEAT")
        h = [sk for sk in ordered if crc32(_skel_id(sk) + "heldout") % 5 == 0] or [ordered[0]]
        heldout.update(h)
        rest = [sk for sk in ordered if sk not in set(h)]
        v = [sk for sk in rest if crc32(_skel_id(sk) + "val") % 20 == 0] or [rest[0]]
        val.update(v)
    return heldout, val
HELDOUT_SKELETONS, VAL_SKELETONS = _split_maps()
def split_of(sk):
    if sk in HELDOUT_SKELETONS: return "heldout"
    if sk in VAL_SKELETONS: return "val"
    return "train"
```

**终算子收尾（唯一入口）**：`value`/`goal` 为单生产者（只 `submit`）；`verify`/`goal_verify`
为两生产者（`submit` + 依终值类型选 `check_*`）：

```python
def _commit(family, skeleton, expected):
    plan, spec = list(skeleton) + ["submit"], {}
    if family in ("verify", "goal_verify"):
        if t(expected) == "Int":   spec = {"parity": emod(expected, 2)}; check = "check_parity"
        elif t(expected) == "Str": spec = {"length": len(expected)};    check = "check_len"
        else: return None
        plan.append(check)
    return plan, spec
```

**配方族（follow）**：指令 = 计划线性渲染（含算子义项）：

```python
def instance_follow(rng, root, skeleton, family):
    for _ in range(200):
        x = sample_value(rng, root)
        st = run_plan(list(skeleton), init_state(x=x))
        if st is None: continue
        cs = _commit(family, skeleton, st["x"])
        if cs is None: continue
        plan, spec = cs
        task = Task(style="follow", family=family, instruction=render_recipe(rng, plan, x),
                    x=x, spec=spec, expected=st["x"], plan_hidden=plan, root=root,
                    plan_hash=hash_obj(plan), composition_id=_skel_id((root, skeleton)),
                    split=split_of((root, tuple(skeleton))))
        if has_shortcut(task, GRAPH): continue          # follow 族极小性守卫（R2-P0-3）
        st2 = run_plan(plan, init_state(x=x, spec=spec))
        if st2 is not None and accept(task, st2): return task
    return None
```

**目标族（goal）**：指令**只描述目标谓词、不含任何算子义项**；oracle = 传入骨架本身
（其必须能达标；目标允许多解，故 gold 未必全局最短，冗余由 `steps_over_shortest` 度量）：

```python
INT_GOALS = [lambda r: {"kind": "parity", "target": r.randint(0, 1)},
             lambda r: {"kind": "gt", "target": r.choice([0, 5, 20])}]
STR_GOALS = [lambda r: {"kind": "len", "min": r.randint(1, 2), "max": r.randint(3, 5)}]
# max≤5：echo 产出长度 = len(x)+5 ≥ 6，恒不落在 [min,max] 内 → 构造端直接关死 Str 单步捷径
# 已知覆盖缺口：Str 仅 len 目标、pool=1 → all 合取永不生成（len(pool)>1 为假）；
# v0 接受（Str 算子多为长度变换，len 是唯一可程序化判定的目标属性），Phase 3 加语义叶子时再补。

def sample_goal(rng, root):
    pool = INT_GOALS if root == "Int" else STR_GOALS
    g = rng.choice(pool)(rng)
    if rng.random() < 0.4 and len(pool) > 1:            # 合取目标：强制多步规划
        g = {"kind": "all", "of": [g, rng.choice(pool)(rng)]}
    return g

# world/grammar.ts —— 目标 NL 模板：只描述属性、不含算子义项；**数值必须显式出现**（NUM 依赖）
# parity 用奇偶词（无数字）；gt 严格 >；len 给出区间端点；all 用连接词拼接两条子句。
GOAL_TEMPLATES = {
    "parity": ["结果是{parity_word}数", "让最终值为{parity_word}数", "输出应为{parity_word}数"],
    "gt":     ["结果大于{target}", "让最终值超过{target}", "把结果变成大于{target}的数"],
    "len":    ["长度在{min}到{max}之间", "字符数介于{min}和{max}", "总长度落在{min}与{max}之间"],
}
def render_goal(rng, goal):
    """按 goal 结构渲染；阈值/区间端点一律写进指令，否则 NUM_DIM 无法还原目标。"""
    if goal["kind"] == "all":
        p1, p2 = (render_goal(rng, g) for g in goal["of"][:2])
        return p1 + rng.choice(["，且", "并且", "同时"]) + p2
    tmpl = rng.choice(GOAL_TEMPLATES[goal["kind"]])
    if goal["kind"] == "parity":
        return tmpl.format(parity_word="偶" if goal["target"] == 0 else "奇")
    return tmpl.format(**goal)

def goal_probe_hit(root, plan, goal):
    """可达性探针：需存在一个 probe 使得**输入不满足 goal 但 plan 输出满足**。
    Int 的 PROBE_INT 是全域 ⇒ 判定精确；Str 的探针覆盖常见长度，长度不变类
    （upper/lower/reverse 组合）会被正确判为不可达——因为输入不满足时输出也不满足。"""
    for probe in (PROBE_INT if root == "Int" else PROBE_STR):
        if goal_ok(probe, {"goal": goal}): continue   # 输入已达标 = 无效 witness（R2-P0-2b）
        st = run_plan(list(plan), init_state(x=probe))
        if st is not None and goal_ok(st["x"], {"goal": goal}): return True
    return False

GOAL_PROBE_GOALS = [
    {"kind": "parity", "target": 0}, {"kind": "parity", "target": 1},
    {"kind": "gt", "target": 0}, {"kind": "gt", "target": 5}, {"kind": "gt", "target": 20},
    {"kind": "len", "min": 1, "max": 3}, {"kind": "len", "min": 2, "max": 5},
]
def goal_eligible(root, skeleton):
    """族适格性（R2-P0-2）：该骨架是否存在可达目标（goal 族）。
    Int 全域探针 + 输入不达标过滤 ⇒ 精确；Str 探针覆盖常见长度，长度不变类
    （upper/lower/reverse 组合）对 len 目标恒不可达（输入不达标时输出也不达标）
    → 判不适格，从 goal 族覆盖声明与配额池剔除并计入报告（显式化，不静默报错）。
    修正（R2-P0-2b）：原实现未跳过「输入已达标」的探针，导致长度不变类 Str 骨架
    被误判适格 → instance_goal 永远找不到 witness → make_coverage_split 报错。"""
    for g in GOAL_PROBE_GOALS:
        if goal_probe_hit(root, skeleton, g): return True
    return False

def has_one_step_solution(task, graph):
    """depth-1 捷径守卫：任一单步（含 echo/submit）直接验收通过即拒采。
    只需 O(|candidates|) 次 apply+accept，不必整图 BFS，也避免 gen→teacher 反依赖。"""
    st = init_state(x=task.x, spec=task.spec)
    for a in candidates(graph, st, st["hist"]):
        if a == EXIT: continue
        st2 = apply_op(graph, a, st)
        if st2 is not None and accept(task, st2): return True
    return False

def has_shortcut(task, graph):
    """follow 族极小性守卫（R2-P0-3）：存在比 gold 更短的路径（单步算子 + 收尾提交）
    即拒采，否则 G2.2 超 oracle 率被设计性抬高。
    修正（R2-P0-3b）：必须比对捷径总长（1 步算子 + commit plan）与 gold 长度——
    depth-1 的 gold 本身就是 [op, submit(, check)]，捷径等长而非更短，不应拒采。
    原实现未比长度，导致所有 depth-1 follow 族任务被全拒 → make_coverage_split 报错。
    **落地扩展（R2-P0-3 删任意步版，2026-09-14）**：在单步替换之上增「删任意 ≥1
    骨架步」——gold 骨架段（n≤5）真子序列全枚举（≤31 个），run_plan(子序列)+收尾
    提交过验收且严格短于 goldLen ⇒ 非最小换 witness（见 §10 R4 勘误「执行 A」落地
    状态；Str 采样域结构性非最小判定同节登记）。"""
    gold_len = len(task.plan_hidden)                       # 含 submit(,check)
    st = init_state(x=task.x, spec=task.spec)
    for a in candidates(graph, st, st["hist"]):
        if a == EXIT: continue
        st2 = apply_op(graph, a, st)
        if st2 is None: continue
        cs = _commit(task.family, [], st2["x"])
        if cs is None: continue
        plan2, spec2 = cs
        if 1 + len(plan2) >= gold_len: continue            # 捷径不比 gold 短 → 非捷径
        st3 = run_plan(plan2, st2)
        if st3 is not None and accept(task, st3): return True
    return False

def instance_goal(rng, root, skeleton, family):
    # gold = 传入骨架本身，使 composition_id 与切分骨架严格同一——held-out 的每个骨架
    # 才会被真正考核，也避免"最短解跨骨架漂移"把 held-out 覆盖声明架空。
    for _ in range(80):                                   # 换目标，直到找到可达标者
        goal = sample_goal(rng, root)
        if root == "Int" and not goal_probe_hit(root, skeleton, goal): continue   # Int 精确剪枝
        for _ in range(200):                              # witness 拒绝采样（Str 探针不剪枝）
            x = sample_value(rng, root)
            if goal_ok(x, {"goal": goal}): continue       # 初始态即达标 = 无训练价值 + 单步捷径
            st = run_plan(list(skeleton), init_state(x=x))
            if st is None or not goal_ok(st["x"], {"goal": goal}): continue
            cs = _commit(family, skeleton, st["x"])
            if cs is None: continue
            plan, spec = cs; spec = {**spec, "goal": goal}
            task = Task(style="goal", family=family, instruction=render_goal(rng, goal),
                        x=x, spec=spec, expected=st["x"], plan_hidden=plan, root=root,
                        plan_hash=hash_obj(plan), composition_id=_skel_id((root, tuple(skeleton))),
                        split=split_of((root, tuple(skeleton))))
            if has_one_step_solution(task, GRAPH): continue   # 关死单步 echo/submit 捷径
            st2 = run_plan(plan, init_state(x=x, spec=spec))
            if st2 is not None and accept(task, st2): return task
    return None

STYLES = {"follow": ("value", "verify"), "goal": ("goal", "goal_verify")}
def instance_task(rng, root, skeleton, family, style):
    return (instance_goal if style == "goal" else instance_follow)(rng, root, skeleton, family)

def _pool(split):
    return [sk for sk in SKELETONS if split_of(sk) == split]

def _stratified_choice(rng, pool):
    """层间等概率 + 层内等概率：修掉"骨架均匀抽样 = 几乎全是深度 5"。"""
    by = {}
    for sk in pool: by.setdefault(_stratum(sk), []).append(sk)
    return rng.choice(by[rng.choice(sorted(by))])

def make_task(seed, style="follow", family=None, split=None, skeleton=None):
    rng = make_rng(seed)
    pool = [skeleton] if skeleton else (_pool(split) if split else SKELETONS)
    for _ in range(200):
        sk = skeleton or _stratified_choice(rng, pool)
        fam = family or rng.choice(STYLES[style])
        if fam in ("goal", "goal_verify") and not goal_eligible(sk[0], sk[1]): continue  # 勘误：goal 域适格过滤（R2-P0-2）
        task = instance_task(rng, sk[0], sk[1], fam, style)
        if task is not None and (split is None or task.split == split): return task
    return None

def make_split(split, per_family, seed=0, max_per_skeleton=4):
    """确定性**配额**：每 (style, family) 各生成 per_family 条；轮转顺序固定。
    骨架不够则同骨架多实例化（上限 max_per_skeleton）；仍不够 **报错**，不静默降级。
    适格池为空（epool 空，goal 域骨架全不适格）同样 **显式报错**，不静默换池。
    只用于统计集/val；「每骨架都被考核」由 make_coverage_split 保证，二者不可混用。
    goal 域两族（goal/goal_verify）只走同一适格池（R2-P0-2：长度不变类 Str 骨架对任何
    目标都产不出 goal 域任务；goal_verify 同样携带 goal 谓词，池口径一致）。"""
    rng = make_rng(seed)
    pool = sorted(_pool(split), key=_skel_id)
    out = []
    for style, fams in STYLES.items():
        for fam in fams:
            n = 0
            epool = [sk for sk in pool if fam not in ("goal", "goal_verify") or goal_eligible(sk[0], sk[1])]  # 勘误：goal_verify 也带 goal 谓词，两族同池
            if not epool:
                raise RuntimeError(f"{split}/{style}/{fam}: eligible pool empty")
            for _rep in range(max_per_skeleton):
                for sk in epool:
                    if n >= per_family: break
                    task = instance_task(rng, sk[0], sk[1], fam, style)
                    if task is not None and task.split == split:
                        out.append(task); n += 1
                if n >= per_family: break
            if n < per_family:
                raise RuntimeError(f"{split}/{style}/{fam}: quota {per_family} unmet ({n})")
    return out

def make_coverage_split(split, seed=0):
    """覆盖集：每个适格 held-out 骨架在每 (style, family) 恰好 1 条。
    只允许同骨架重试，**禁止跨骨架顶替**；任一适格骨架产不出即报错（覆盖声明可判定）。
    goal 族覆盖声明缩到适格池（R2-P0-2），不适格骨架数写进报告（显式化，不静默）。"""
    rng = make_rng(seed)
    pool = sorted(_pool(split), key=_skel_id)
    out = []
    for style, fams in STYLES.items():
        for fam in fams:
            epool = [sk for sk in pool if fam not in ("goal", "goal_verify") or goal_eligible(sk[0], sk[1])]  # 勘误：goal_verify 也带 goal 谓词，两族同池
            if not epool:
                raise RuntimeError(f"coverage {split}/{style}/{fam}: eligible pool empty")
            for sk in epool:
                task = None
                for _ in range(50):                       # 同骨架重试，不换骨架
                    t = instance_task(rng, sk[0], sk[1], fam, style)
                    if t is not None and t.split == split: task = t; break
                if task is None:
                    raise RuntimeError(
                        f"coverage {split}/{style}/{fam}/{_skel_id(sk)}: skeleton yields no task")
                out.append(task)
    return out
```

> 说明：`expected` 由回放求出（配方族=计划输出；目标族=达标 witness，仅供调试），控制器不见。
> `render_recipe` 按计划顺序渲染算子义项（≥3 义项、随机连接词）；`render_goal` **只描述目标
> 属性、绝不出现算子义项**。义项与目标词表都是**世界文法的一部分**（C.6 LEXICON），
> 至少两个算子共享一个**歧义义项**，且歧义必须**可由类型判定**（如共享义项跨 Int/Str 算子），
> 否则同一指令会对应多个不同 gold（P1-9）。
>
> **去重键** = `(style, composition_id, instruction, x, expected, plan_hash)`；`task_hash` 不含
> `plan`，故 `plan_hash` 必须单独进去重键。训练/held-out 切分只看 `composition_id`（骨架），
> 与 style 无关——保证两条采样路径分布一致。

## C.1.5 课程学习（gen/difficulty.ts，唯一实现）

- 训练集采样默认按课程推进：先只采 `_stratum(sk)` 深度 ≤ 2 的浅层 STRATA，该层 val
  pass@1 ≥ 0.9 后逐层开放，直到全深度；`CURRICULUM_OFF=true` 可关，作对照臂。
- 层内仍走 `_stratified_choice`；课程只改**训练集采样顺序/配额**，不改骨架枚举、切分与
  held-out 定义——G0.5 与 held-out 覆盖声明不因课程而变。
- 属"难度旋钮"：生成器之外的可控参数，不是新数据源；报告固定 on/off 并分列曲线。
- **相似性退火（池内配额）**：同阶段内每骨架实例配额由高到低退火（"高相同 → 各不相同"），
  池内骨架**全量覆盖**（高相同 = 池内高配额，不是砍池）；最终阶段收敛回 `_stratified_choice`
  均匀采样，端点与无条件训练可比；纪律同上——只改训练采样配额，不改切分/held-out。

确定性哈希（全项目统一；**禁内置 `hash()`**，跨进程随机化会毁掉 G0.1）：

```python
def hash_obj(o) -> str:
    s = json.dumps(o, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]
def crc32(s: str) -> int:
    return zlib.crc32(s.encode("utf-8")) & 0xFFFFFFFF
```

`task_hash = hash_obj({ "instruction": instr, "family": family, "x": x,
"expected": expected, "world_version": world_version })`（**字典，不是集合**）。

## C.2 验收器 + 通道表 + 沙箱

```python
CHANNEL = {"value": ("answer",), "verify": ("answer", "verdict"),
           "goal": ("answer",), "goal_verify": ("answer", "verdict")}
def accept_channeled(task, state) -> Verdict:
    # 1) 只读本族允许的 provides 字段（其它字段一律不参与判定）
    for f in CHANNEL[task.family]:
        if f not in state or state[f] is None: return Verdict(False, "missing:"+f)
    # 2) 交给 B.4 accept（值 / 目标谓词 / 两生产者 verdict），这里不重写判定
    ...
```

沙箱（Phase 3 代码族才真正用；v0 只建接口；`.py` 为算法规格，落盘为 `verify/sandbox.ts`；
rlimit 仅 POSIX，Windows 退化为超时）：

```python
def run_sandboxed(code: str, tests: str, timeout_s=10) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as d:
        write(join(d, "mod.py"), code); write(join(d, "test.py"), tests)
        try:
            r = subprocess.run([sys.executable, "test.py"], cwd=d,
                               capture_output=True, text=True, timeout=timeout_s)
            return r.returncode == 0, r.stdout + r.stderr
        except subprocess.TimeoutExpired:
            return False, "timeout"
```

## C.3 Oracle teacher（逐步标签）

```python
# teacher/oracle.py  —— Phase 1–2 唯一进训练集的标签源（on-path only）
def oracle_trace(task, graph) -> list[Step]:
    st = init_state(x=task.x, spec=task.spec)    # 不含 expected
    trace = []
    for op_id in task.plan_hidden:
        cand = candidates(graph, st, st["hist"])
        assert op_id in cand, (op_id, cand)      # 契约/访问上限/可达性自检
        trace.append(Step(step=len(trace), obs=obs_snapshot(st), candidates=cand,
                          action=op_id))
        st = apply_op(graph, op_id, st)
        assert st is not None
    assert accept(task, st)                      # 最后一步是验收态
    trace.append(Step(step=len(trace), obs=obs_snapshot(st),
                      candidates=candidates(graph, st, st["hist"]), action=EXIT))
    return trace
```

> **标签纪律**：训练集只收 oracle 的 on-path 标签（状态恰好落在 gold 前缀上）。
> 控制器看不见 `expected`，只能跟指令走；`plan_bfs` 找的是"任意到达验收态的路径"，
> 与 oracle 在同一 obs 上会给出不同 action——若混入训练集，正好触发 quarantine 与
> 标签冲突。**因此 `plan_bfs` 在 Phase 1–2 只做可解性 QA、G2.2 与公开规划臂，不进训练集。**

## C.4 Search teacher（BFS 最短解：QA + G2.2 + 公开规划臂）

> v0 边权恒 1 且 `state_digest` 完备 → **用 BFS 而非 DFS**：一次得到精确最短解，
> "有解必找到"与"步数即最优"同时成立，`steps_over_shortest`/G2.2 才有严格基准。
> goal 族 `accept` 只读公开 `spec`，故同一 `plan_bfs` 就是 goal 的**公开规划臂**
> （C.7 上界）。搜索只作 QA / G2.2 / 诊断臂，**不进训练集、不进特征**。

```python
# teacher/search.ts
def state_digest(st) -> str:
    """去重键 = 值字段 + 逐算子计数（**不含完整 hist**）。计数必须进键：MAX_REPEAT 依赖它，
    否则同值不同访问次数的状态被误并，唯一可行延续会被剪掉（搜索不完备）。"""
    counts = {}
    for nid in st.get("hist", []): counts[nid] = counts.get(nid, 0) + 1
    return hash_obj({"x": st.get("x"), "answer": st.get("answer"),
                     "verdict": st.get("verdict"), "counts": counts})

def plan_bfs(task, graph, node_budget=2_000_000) -> list[str] | None:
    """BFS 最短解（`from collections import deque`）。边权恒 1 + 去重键完备 ⇒
    首个出队的 accepted 态即最短解；有解必找到，无解返回 None。"""
    start = init_state(x=task.x, spec=task.spec)
    q = deque([(start, [])])
    seen = {state_digest(start)}
    expanded = 0
    while q:
        st, plan = q.popleft()
        expanded += 1
        if expanded > node_budget:                 # 预算在出队点检查，超限 fail-fast
            raise RuntimeError("search budget exceeded")
        if accept(task, st): return plan           # BFS 序 ⇒ 最短（不含 EXIT）
        if len(plan) >= MAX_STEPS: continue
        for a in candidates(graph, st, plan):
            if a == EXIT: continue
            st2 = apply_op(graph, a, st)
            if st2 is None: continue
            h = state_digest(st2)
            if h in seen: continue
            seen.add(h)
            q.append((st2, plan + [a]))
    return None
```

`plan_bfs` 的产出**仅用于**：① 可解性 QA（生成器说可解，BFS 必须能找到）；
② G2.2 超 oracle 统计；③ goal 族公开规划臂（C.7 上界）。**不进训练集**（标签纪律见 C.3/E.13）。
G2.2 口径必须同源：`plan_bfs` 与 oracle 的 `plan_hidden` **都不含 EXIT**，
按算子步数比较 `len(bfs_plan) < len(oracle_plan)`；禁止拿含 EXIT 的 trace 长度去比。
G2.2 只需"是否存在更短解"：深度限到 `len(gold)-1` 即早停，不必全深度；全深度 BFS 只留给
统计集上的 `steps_over_shortest`，且超预算记 ∞ 桶（不 raise），避免单任务炸停评测。

## C.5 DAgger + 蒸馏

```python
# controller/train.py  —— 唯一 Python：只做离线批量拟合。
# BC 模式（--loss ce）：读 records.bin 的 (obs, cand_mask, target_idx)，不接触环境/rollout。
# REINFORCE 模式（--loss reinforce，G2.3 对照臂）：TS 侧已产好 (obs, cand_mask, action, reward)
#   写进 reinforce.bin，Python 只做批量策略梯度更新——仍不自己做 rollout。
def bc_train(D, val_D, epochs=30, patience=4, min_epochs=5, min_delta=1e-4, seed=0,
             batch=512, lr_schedule="cosine", ...):
    # D / val_D: list[(obs, cand_mask, target_idx)]，特征已由 TS 侧算好并内联
    # 早停用 val CE（连续量），不用被降级为诊断项的 route_acc——指标链与门禁链对齐。
    # Python 只负责拟合与按 CE 早停；最终 checkpoint 由 TS 侧在 VAL_SKELETONS 上按
    # greedy pass@1 于最后 K 个 epoch 中选定（C.7/C.8），保证端点=主指标。
    rng = random.Random(seed)                 # 显式 seed（E.8）
    best, best_ce, bad = None, float("inf"), 0
    for epoch in range(epochs):
        if lr_schedule == "cosine":           # 可选 cosine 衰减，默认开；对照关掉验证稳定性
            lr = 3e-3 * 0.5 * (1 + math.cos(math.pi * epoch / epochs))
        rng.shuffle(D)
        for batch in batches(D, batch):
            grads = policy.backward(batch, loss="ce", label_smoothing=0.05, weight_decay=1e-4)
            opt.step(grads)
        ce = val_ce(policy, val_D)            # val 来源见 C.1（VAL_SKELETONS，按骨架切）
        if ce < best_ce - min_delta:
            best, best_ce, bad = snapshot(policy), ce, 0
        else:
            bad += 1
            if bad >= patience and epoch + 1 >= min_epochs: break
    return best
```

> **batch 唯一口径 = 512**（H.2 的 2048 只是容量上限弹性，不是默认）。
> **checkpoint 选择**：`--save-last-k K`（默认 K=5，钉死不降）落最近 K 个 epoch 快照，
> TS 侧在 `VAL_SKELETONS` 按 greedy pass@1 选点；另以 EMA/polyak（β=0.99）对最后 K 个
> 快照做权重平均，作为**对照候选**（不收成默认，避免掩盖单点选点的真实曲线）。

```typescript
// runner/dagger.ts —— DAgger 编排在 TS（rollout 需要 TS 环境；Python 只拟合）
function correctGold(task, st, a): string | null {
  const k = st.hist.length;
  if (!samePrefix(st.hist, task.plan_hidden, k)) return null;   // off-path 一律不打标
  const goldNext = k < task.plan_hidden.length ? task.plan_hidden[k] : EXIT;
  return a === goldNext ? null : goldNext;
}
function dagger(env, policy, iters = 3, tasksPerIter = 2000, maxFixes = 4) {
  let D = env.oracleRecords();                  // Phase 1：只喂 on-path oracle 轨迹
  const valD = env.valRecords();
  for (let it = 0; it < iters; it++) {
    const Da = [];
    for (const task of env.sample(tasksPerIter, "train")) {
      let st = initState(task.x, task.spec);
      let fixes = 0;
      for (let step = 0; step < MAX_STEPS; step++) {
        const cand = candidates(env.graph, st, st.hist);
        const a = policy.act(st, cand, false);
        const fix = correctGold(task, st, a);     // 先判早退/偏离（EXIT 也在判内）
        if (fix !== null) {
          Da.push(recordOf(st, cand, fix));
          if (++fixes >= maxFixes) break;         // 单 rollout 上限，防同一轨迹过度偏倚
          if (fix === EXIT) break;
          st = applyOp(env.graph, fix, st);       // 老师干预后继续：状态回到 gold 前缀，
          if (st === null) break;                 // 之后的偏离仍是合法 on-path 标签
          continue;
        }
        if (a === EXIT) break;
        st = applyOp(env.graph, a, st);
        if (st === null) break;
      }
    }
    D = D.concat(Da);
    policy = loadWeights(trainPython(D, valD));   // 唯一跨语言：写 records.jsonl / 读 weights.json
  }
  return policy;
}
```

> **KD / 迭代自训练（search 蒸馏、best-of-n 自产轨迹）推迟到 Phase 2 之后**，且必须等
> BC 的 scaling 曲线出来、确认瓶颈不是数据/表示之后再开——否则 search 质量与标签口径
> 会污染 G1.x 的结论。开启时另立门禁：只蒸馏"控制器在黄金前缀状态上的 search 分布"。
>
> 触顶且三分诊断命中「数据覆盖」时，**第一杠杆 = 自模仿过滤**：控制器自身验收通过的
> rollout 重新进 BC 池（标签 = 自身动作，必须过 `accept` 过滤；与 oracle 标签冲突的样本
> 照 quarantine 纪律隔离），**先于** KD/search 蒸馏——它不改标签源口径，只是用验收器做
> 数据筛选，是纯数据量手段；KD 仍是其后才开的标签口径变化。
>
> **on-path 纪律 + 老师干预**：偏离处打 gold 动作后**继续 rollout**（不 break），状态回到
> gold 前缀，之后的每次偏离仍是合法 on-path 标签；单 rollout 上限 `maxFixes=4` 防重复偏倚。
> 真正无监督的仍是**首次偏离之前未经过的 off-path 状态**，故 G2.1 仍是**诊断指标**
> （记录偏离步分布与条数），不作晋级门槛。**命名更正**：本机制是"on-path 干预"（类
> Scheduled Sampling），只在 gold 前缀状态打标，**不教错误恢复**，只教"避免首次错误"；
> greedy pass@1 下够用，报告不得据此声称学到恢复能力。
>
> **进度 critic 辅助头（补 greedy 回溯短板，零 RL 零搜索）**：`policy` 在 `h` 上挂一个
> 回归头 `ĥ(h) → 距 gold 终点剩余步数`（标签来自 oracle trace 的 on-path 步数，Phase 1
> 就训，不碰 off-path、不改标签口径）；推理不消费它，只用于诊断"贪心是否在绕路"与
> 触顶时定位"前瞻缺失"；`--head progress` 开关，默认开。
> **落地口径**：标签 = (轨迹末步 stepIndex − 本步 stepIndex)/MAX_STEPS（TS featurize 按
> task_hash 分组推导，随行入 bin），仅完整轨迹参与（progressWeight=1）；损失 =
> λ·0.5·Σw(ĝ−y)²/max(1,Σw)，λ=0.1（在 Python 训练器与 CE 主损失合训）。

## C.6 可微控制器：特征 / 前向 / 反向 / Adam（照抄）

**特征（obs 与 action 分离，pointer 式动态候选集打分）**

```python
# controller/features.ts
ROUTING = sorted(set(NODES) - {ENTRY})                  # 含 exit；候选参考序
N_ACTIONS = len(ROUTING)                                # 基础世界 22；仅作候选枚举参考

FIELD_ORDER = ["x", "answer", "verdict"]                # 白名单：不含 expected/spec/hist
STATE_DIM   = len(FIELD_ORDER) * 10                     # present1 + type_onehot6 + 值(1) + |值|(1) + parity(1) = 30
HIST_LEN   = 12                                         # 滚窗 = MAX_STEPS：覆盖最长 gold 路径，偏离 rollout 不丢早期算子
HIST_SLOTS = 32                                         # 固定槽位容量；槽位 = 追加式稳定索引（不哈希）
HIST_DIM   = HIST_LEN * HIST_SLOTS                      # 与当前节点数解耦 = 384
# NODE_SLOT：追加式稳定索引，基础节点按基础顺序占 0..21，结构新增节点依次占 22…；
# 容量内 dims 不变且零碰撞（哈希桶对 22 节点约有 6 处碰撞，会丢"哪个算子用过"）。
NODE_SLOT = build_node_slots(NODES_BASE, HIST_SLOTS)
LEX_OPS_BASE = [op.id for op in OPS if op.kind in ("op", "terminal")]  # 基础词表，冻结
MENTION_DIM  = len(LEX_OPS_BASE) * 3                    # 命中数 / 首现位置 / 序位rank = 45
GOAL_LEX = {"parity": ["偶数", "奇数", "双数", "单数"],
            "gt":     ["大于", "超过", "多于", "高过"],   # gt 是严格 >，禁用"不小于"（≥ 语义会污染标签）
            "len":    ["长度", "位数", "字符数", "之间"],
            "conj":   ["且", "并且", "同时"]}             # all 合取连接词：显式维度，不赌 hash 袋可分
GOAL_HINT_DIM = len(GOAL_LEX) * 2                       # 每类目标义项：命中数 / 首现 = 8
NUM_DIM       = 8                                       # 指令解析的数值目标：4×(存在, 归一值)
HASH_DIM      = 256                                     # 兜底；mention 是配方族主信息

# 动作特征 = 契约派生 + 哈希算子桶：新增算子不改 ACT_DIM（Phase 4 漂移自修复的前提）
PROVIDES_LIST = ["x", "answer", "verdict"]                      # 3
KIND_LIST     = ["op", "terminal", "decoy", "exit"]             # 4
TYPE_LIST     = ["Int", "Str", "Bool", "List", "Json", "None"]  # 6
OP_BUCKETS    = 64
P_OFF = 0                                                       # provides: [0,3)
K_OFF = P_OFF + len(PROVIDES_LIST)                              # kind:     [3,7)
T_OFF = K_OFF + len(KIND_LIST)                                  # accepts6 + returns6: [7,19)
E_OFF = T_OFF + 2 * len(TYPE_LIST)                              # 哈希桶:   [19,83)
ACT_DIM = E_OFF + OP_BUCKETS                                    # 19 + 64 = 83

OBS_DIM = MENTION_DIM + GOAL_HINT_DIM + NUM_DIM + HASH_DIM + STATE_DIM + HIST_DIM + 1
# 45 + 8 + 8 + 256 + 30 + 384 + 1 = 732；+1 = step 进度；全部只来自公开 instruction/state
```

```python
def state_stats(v) -> tuple:
    """白名单字段摘要（不含 expected）：(带符号值, 幅度, 奇偶)。R2-P0-4：Int 必须保留符号与奇偶，
    否则 gt（严格 >）与 cond_even 在 goal 族系统性盲视——abs 抹号是原设计的特征级缺陷。"""
    if v is None: return (0.0, 0.0, 0.0)
    if isinstance(v, bool): return (1.0 if v else 0.0, 0.0, 0.0)
    if isinstance(v, int): return (math.tanh(v / 50.0), min(1.0, abs(v) / 100.0), float(emod(v, 2)))
    if isinstance(v, str): return (min(1.0, len(v) / 16.0), 0.0, 0.0)
    return (0.0, 0.0, 0.0)

def hist_features(hist) -> np.ndarray:
    """HIST_LEN 滚窗 + 追加式稳定槽位（`NODE_SLOT`，零碰撞）：节点数解耦见 I.2。"""
    a = np.zeros(HIST_DIM, dtype=np.float32)
    for j, nid in enumerate(list(hist)[-HIST_LEN:][::-1]):
        s = NODE_SLOT.get(nid)
        if s is not None:
            if s >= HIST_SLOTS: raise RuntimeError("NODE_SLOT 超容：需 bump HIST_SLOTS 与 arch")  # 附录 G.7 禁静默降级
            a[j * HIST_SLOTS + s] = 1.0
    return a

def featurize_instr(instr) -> np.ndarray:
    """公开指令特征（语言优先）：算子义项 + 目标义项 + 解析出的数值目标 + hash 兜底。
    全部只来自 instruction，绝不读 spec/goal/expected；`hash_only` 消融臂把前三段
    **删除**（instr 块仅余 HASH → OBS_DIM 671，与「三者 dims 不同」条款自洽，非置零）。
    `mention_stats` 同时接受 op_id 与义项列表，唯一实现见 world/grammar.ts。"""
    toks = tokens(instr)                              # CJK 按字符 bigram，ASCII 词/字符
    mention = np.zeros(MENTION_DIM, dtype=np.float32)
    for k, op_id in enumerate(LEX_OPS_BASE):
        hits, first, rank = mention_stats(toks, op_id)
        mention[3*k + 0] = min(1.0, hits / 3.0)
        mention[3*k + 1] = (1.0 - first / max(1, len(toks))) if first >= 0 else 0.0
        mention[3*k + 2] = 1.0 - rank / max(1, len(LEX_OPS_BASE))
    goal_hint = np.zeros(GOAL_HINT_DIM, dtype=np.float32)   # 目标类别义项 parity/gt/len
    for k, words in enumerate(GOAL_LEX.values()):
        hits, first, _ = mention_stats(toks, words)
        goal_hint[2*k + 0] = min(1.0, hits / 3.0)
        goal_hint[2*k + 1] = (1.0 - first / max(1, len(toks))) if first >= 0 else 0.0
    num_hint = np.zeros(NUM_DIM, dtype=np.float32)          # 指令里的阈值/区间端点
    nums = [int(v) for v in re.findall(r"-?\d+", instr)][: NUM_DIM // 2]
    for j, v in enumerate(nums):
        num_hint[2*j + 0] = 1.0
        num_hint[2*j + 1] = max(-1.0, min(1.0, v / 50.0))
    hashed = np.zeros(HASH_DIM, dtype=np.float32)
    for tok in toks: hashed[crc32(tok) % HASH_DIM] += 1.0
    nrm = np.linalg.norm(hashed)
    if nrm > 0: hashed /= nrm
    return np.concatenate([mention, goal_hint, num_hint, hashed])

def featurize_state(st) -> np.ndarray:
    out = []
    for f in FIELD_ORDER:
        val = st.get(f)
        out.append(1.0 if val is not None else 0.0)
        oh = [0.0] * 6; oh[TYPE_INDEX[t(val)]] = 1.0; out += oh   # 6 = len(TYPE_LIST)
        out += state_stats(val)                          # 值 / |值| / 奇偶（R2-P0-4）
    return np.array(out, dtype=np.float32)

def featurize_action(graph, nid) -> np.ndarray:
    """契约派生：provides/kind/accepts/returns + 哈希算子桶；相同契约的算子靠哈希桶区分。"""
    a = np.zeros(ACT_DIM, dtype=np.float32)
    if nid == EXIT:
        a[K_OFF + KIND_LIST.index("exit")] = 1.0; return a
    n = graph.nodes[nid]
    if n.provides in PROVIDES_LIST: a[P_OFF + PROVIDES_LIST.index(n.provides)] = 1.0
    a[K_OFF + KIND_LIST.index(n.kind)] = 1.0
    for ty in n.requires_types:                 # "any" 已由派生层剔除
        if ty in TYPE_LIST: a[T_OFF + TYPE_LIST.index(ty)] = 1.0
    if n.out_type in TYPE_LIST:                 # "any" = 动态类型，不置位
        a[T_OFF + len(TYPE_LIST) + TYPE_LIST.index(n.out_type)] = 1.0
    a[E_OFF + (crc32(nid) % OP_BUCKETS)] = 1.0
    return a
```

> **归纳偏置（语言优先）**：配方族主信息走"逐算子义项显式提及"（LEXICON 是合成世界文法的
> 一部分），**含终算子**（"发不发 check、发哪个 check"是关键决策）；目标族走"目标义项
> （parity/gt/len 词）+ 指令解析出的数值目标"通道，仍**只读 instruction**、不碰 `spec`。
> 歧义义项必须**可由类型判定**，否则同指令对应多 gold（P1-9）。
> 启发式臂用同一 LEXICON 做线性首现顺序解析（仅对配方族；目标族见 C.7）。
>
> 动作特征契约化 + 哈希桶后，**替换/扰动同契约算子不改 `ACT_DIM`**；`OBS_DIM` 只有在
> I.2 编码不变式成立时才对"新增节点"稳定（`MENTION_DIM` 冻结基础词表、`hist` 改追加式槽位、
> `cand_mask` 变长），否则每加一个节点都要新 `arch` 版本并重训；`weights.json` 按 arch
> fail-fast，**禁止跨版本静默加载**。这也正是保留 pointer 而非折叠成固定掩码 MLP 的原因
>（动作特征不再是 one-hot，同契约算子靠哈希桶区分；仅当退化为固定 one-hot 时才可折叠）。
>
> **特征集（`FEATURE_SET`，arch 版本的一部分）**：主臂 = `lang`（本节默认，语言优先）；
> `struct` = 诊断上界臂，额外加 `GOAL_STRUCT_DIM=8` 的 `spec.goal` 紧凑编码（kind onehot3 +
> 5 个归一化参数，**只用于上界诊断、绝不进主臂训练信号**）；`hash_only` = 消融臂（**删段**：
> mention/goal_hint/num 三块不占位，instr 块仅 HASH 256 → OBS_DIM 671）。三者 arch 不同、
> dims 不同，按 arch fail-fast，不混用权重。
>
> `learned` = **条件激活的诊断臂（默认不建）**：字符级可学习 embedding + 一层小自注意力编码
> instruction（numpy 手写反向，~2M 参数），其余特征不变。**仅在** G0.6 编码器迭代 M 轮仍不
> 达标、或 scaling 触顶且三分诊断命中「表示容量」时激活，用于复核表示上限；只服务诊断，
> 不进门禁、不进主指标、不参与 Phase 4 漂移可比性声明。激活前先试更便宜的容量旋钮
> （`lang` 主臂 H 128→256），区分「容量」与「表示」两个瓶颈。
>
> **容量风险（已被 G0.6 前移拦截）**：若 `lang` 特征集下目标分类不达标，先在 Phase 0 改编码器
> （§A.2 G0.6），不要带着表示瓶颈去跑整条 scaling 曲线。
>
> 工程细节：obs 稀疏（非零 ≈ mention ≤45 + goal ≤16 + hashed ≤词数 + state ≤30 + hist ≤12），
> 编码器按批次稠密化（`O @ Wo.T`，见 H.2）；records 用稀疏 `{idx,val}` + 候选**位掩码**。
> batch backward 对变长候选集做 mask/padding：pad 到 `M=max(m)`，softmax 前把无效位置
> `-inf`，只在有效位累加梯度（附录 D 的数值梯度测试要覆盖变长与 mask）。

**前向（factorized bilinear pointer）**

```python
# controller/policy.py ; H=128
h    = np.tanh(Wo @ o + bo)                 # (H,)
z_i  = np.tanh(Wa @ a_i + ba)               # (H,) 每个候选
s_i  = w_s @ (h * z_i)                       # 标量分数
p    = softmax([s_1..s_m])                   # 候选集内归一化
```

**反向（batch 单步；y=onehot(target)；KD 时另加 beta*(p-q)）**

```
y_i    = (1 - eps_ls) * onehot(target)_i + eps_ls / m     # label smoothing（在 softmax 前构造）
g_i   = p_i - y_i                              # 若 KD（Phase 2+）: g_i += beta*(p_i - q_i)
d_w_s  = Σ_i g_i * (h * z_i)
dh     = Σ_i g_i * (w_s * z_i)
dz_i   = g_i * (w_s * h)
Wa_grad += outer(dz_i * (1 - z_i**2), a_i)
ba_grad += dz_i * (1 - z_i**2)
Wo_grad += outer(dh * (1 - h**2), o)
bo_grad += dh * (1 - h**2)
```

**Adam（逐参数，标准式）**

```
m = beta1*m + (1-beta1)*g ; v = beta2*v + (1-beta2)*g*g
mhat = m/(1-beta1**t)     ; vhat = v/(1-beta2**t)
p = p - lr * mhat / (sqrt(vhat) + eps)     # lr=3e-3, beta1=.9, beta2=.999, eps=1e-8
```

## C.7 运行 / 评测循环与指标公式

```python
MAX_STEPS = 12                       # 深度5 + submit + check + exit = 8，留 4 步冗余
def rollout(policy, graph, task, greedy=True, max_steps=MAX_STEPS):
    st = init_state(x=task.x, spec=task.spec); trace = []
    for _ in range(max_steps):
        cand = candidates(graph, st, st["hist"])
        if len(cand) == 1: a = cand[0]
        else: a = policy.act(st, cand, greedy)
        trace.append((obs_snapshot(st), cand, a))
        if a == EXIT: return trace, accept(task, st)
        st = apply_op(graph, a, st)
        if st is None: return trace, False
    return trace, False
```

指标（`eval/metrics.ts`）：

- `pass@1 = 解出任务数 / 任务数`（greedy，每题只跑一次）——**主指标**，按 `style` 分别报。
- `routing_acc`：**诊断项**（teacher-forced 比对 argmax）。`submit`/`check` 可交换、等价路径
  会被判错，故只作诊断，不作门禁。
- `path_excess`（配方族，gold 唯一）：`mean(len(ctrl_plan) − len(gold_plan))`，仅成功任务。
- `steps_over_shortest`（目标族）：相对**穷尽最短解**的冗余步数。
- 所有 `pass@1` 必须给 95% CI（held-out n 小、p 在 0.5 附近时半宽很大）。

**三臂（`eval/arms.ts`），按 style 分别报告**：

| style | 臂 | 说明 |
|---|---|---|
| follow（配方） | `HeuristicArm` | LEXICON 线性首现顺序**弱词法扫描**（中文义项，非英文 id）：`tokens` 切分后按各义项首次命中位置升序逐位定算子；同一位置命中多算子（共享义项如 `取反` 命中 neg/reverse）时**不做类型消歧、不读 root**，按 `LEX_OPS_BASE` 固定算子序取最小者；该步选出的算子不在 candidates 时**整步跳过**继续。渲染成 `取反` 的 reverse 步被选成 neg、在 Str 状态不进 candidates 而跳过 → 产生稳定失败率 |
| | `RandomArm` | 同架构随机权重 |
| | `TrainedArm` | BC（Phase 2 起可选 +DAgger） |
| | `ContractRouteArm` | 廉价机制对照：公开声明反向链（契约合法候选内 provides 满足度贪心 + 缺边补边），零学习零泄漏 |
| goal（目标） | `RandomArm` | 下界；LINEAR 启发式**不适用**（指令无算子义项），记 N/A |
| | `PlannerArm` | **公开规划上界**：`plan_bfs` 只用 instruction/初始态/`spec`（goal 的 accept 本就公开），非训练信号 |
| | `ContractRouteArm` | **廉价中档基线**（goal 族此前缺此档）：同上，声明反向链；held-out 组合上必然崩 = 证明组合能力只能靠训练获得 |
| | `TrainedArm` | 主对照：成功随数据量上升即"编排被学会" |

> 廉价臂只作**对照列**：不进 `S_ctrl` 主指标、不进训练集、goal 族禁止用 oracle/gold 建宏
> （评测期缓存 hidden plan = 泄漏）。系统级"宏保险丝"（trained + 技能宏兜底，成功非降才晋升）
> 属引擎形态预演，Phase 3+ 实证，不进 Phase 0–2 门禁/主指标；宏无组合泛化，上限 = 已见任务缓存。
> **ContractRouteArm v0 口径（已落地 `eval/contract_route.ts`）**：只读公开面（candidates/
> 契约/`spec.goal`/accept），确定性贪心、≤MAX_STEPS：① goal 域且 `goalOk(x)` 且 submit 合法
> → submit；② verify 域且 verdict 为空且 check_* 合法 → 候选序首个 check_*；③ submit 合法
> → submit；④ 存在非 EXIT 候选 → 候选序首个；⑤ 否则 EXIT。即「provides 满足度贪心 + 缺边补边」。

> **HeuristicArm = 弱词法扫描（本表口径，有意弱化，已落地）**：分词/义项匹配仍走 world 层唯一口径
> （`tokens`/`findSequence`/`senseTokens`/`LEXICON`/`LEX_OPS_BASE`），只在「同位选算子」环节放弃类型消歧。
> 动机（R3-P1-1）：类型感知 `parseRecipe` 在 follow held-out 上实测 pass@1=1.0（`runs/scale-demo-20260913T072730`，
> n=600），`S_follow − S_heur ≥ 0.05` 结构上不可满足（trained ≤ 1.0），且与 A.1「目标式族是唯一不能被
> 线性解析白拿」的定位不符；弱扫描才是本表"歧义按固定算子序 tie-break"的字面规格。**首次 scale 报告须附
> 校准列**：同 held-out 上 parseRecipe 版与弱扫描版 `S_heur` 各一值；门禁只用弱扫描口径（`S_heur_follow`）。
>
> `S_heur` 只在 follow 族作为对照；goal 族用 random 下界 + PlannerArm 上界共同定位：
> `Trained ≪ Planner` ⇒ 表示容量/数据瓶颈；`Trained ≈ Planner` ⇒ 任务设计/标签瓶颈
> （§12"三分诊断"的可执行判据）。`S_rand` 只是 sanity check，不是有意义阈值——**期望值以实测为准**：
> goal 族实测 pass@1=0.0267（n=600，CI [0.0165, 0.0429]，G1.1）：goal 多解/短解占比使随机臂远高于
> 朴素估计 13⁻⁸，勿拿 13⁻⁸ 当标尺；若 ContractRouteArm 在 goal held-out 上接近 trained，触发
> §12「世界太易」诊断。
>
> 诊断臂（不进门禁、不进训练）：`struct`（结构化 `spec.goal` 编码）测"语言→编排"被移除后的
> 上界差；`hash_only`（**删段** mention/goal_hint/num，OBS_DIM 671）测编码器消融。
> Phase 3 增补 `LLMZeroShotArm`：冻结前沿 LLM 读候选契约菜单直接选（pin 死、greedy）——
> 回答"105k 参数的小控制器学到了 frozen LLM 在同环境学不到什么"（组合泛化/契约长程记账）。

## C.8 数据 scaling 实验协议（照抄）

- N 网格：`{100, 300, 1000, 3000, 10000, 30000}`；seed：`{0,1,2,3,4}`。
- 训练集：只从 `split=="train"` 的骨架实例化（`make_task(..., split="train")`），N 条，
  两种 style 按比例混合（默认 50/50，报告须固定比例）。
- val：`make_split("val", per_family=200)`（`VAL_SKELETONS`，与 held-out 零重叠）。
- held-out 分两套，均 `split=heldout`、与 train 骨架零重叠：
  - **覆盖集**：`make_coverage_split("heldout")`——每个 held-out 骨架在每 `(style,family)`
    **恰好 1 条**，产不出即报错（不是 `make_split` 的配额顶替）。
  - **统计集**：`make_split("heldout", per_family=min(max(30, len(HELDOUT_SKELETONS)), HELDOUT_CAP))`，
    `HELDOUT_CAP=300`——上限防止骨架数膨胀时 held-out 反超训练 N；`(style×family)` 四组配额固定。
  - 主指标以统计集为准并报 95% CI；覆盖集只报每骨架 pass/fail 覆盖率（sanity）。
- 主指标按 `style` 分别报 `pass@1` + 95% CI；follow 报 `S_heur`，goal 报 random + `S_planner`。
- 额外报告**校准列**：held-out 中与 train 骨架**无前缀重叠**的子集成功率（前缀重叠会抬高
  组合泛化分；仅校准，不进门禁）。
- 每个 (N, seed)：`bc_train`（按 val CE 早停；Phase 2 起可选 `dagger`）→ TS 侧在
  `VAL_SKELETONS` 上按 greedy pass@1 于最后 K 个 epoch checkpoint 中选定终点 →
  在 held-out 跑 greedy → 记录 `pass@1 / path_excess / steps_over_shortest`（`routing_acc` 诊断）。
  另报**安全动作集冲突率**（目标族，抽样 ≤200 个 on-path 状态 + bounded BFS，诊断项不进门禁）。
  **训练集只含 on-path oracle 标签。**
- 产出：`runs/scale_<ts>/results.{json,csv}`（长表：N,seed,style,arm,metric,value）+ 均值±std
  + 幂律拟合（S∞, α 带 CI）。
- **组合覆盖度副轴（k% 曲线）**：训练骨架随机取 k%∈{10,25,50,75,100}（每层同比例），
  余下同源骨架作 held-out 组合测试，画"组合成功率 × 训练骨架覆盖度"——直接量化
  "覆盖度 → 组合能力"兑换（对齐 repertoire 覆盖度目标）；主指标仍以 N 实例曲线为准（A.1 不动），
  两轴分列报告，禁止互相顶替。
- 结论句式固定：`S_ctrl(N)` 随 N 的变化（**分 style**）+ 与随机/启发式的差 + 是否满足 A.1；
  若 `S_ctrl` 不达标，必须附"表示容量 / 数据覆盖 / 标签口径"三分诊断，不许改阈值。
- **G0.5 分布对齐**：train/heldout 的深度×cond 层分布 KL 必须 < 0.05（同源 `STRATA` 保证）。
  该 KL 由构造近似同义反复，另须报告 goal 族 **gold 骨架分布**作 sanity（覆盖声明的真正证据），
  并报 **per-stratum（深度×cond）held-out 覆盖率边距**（每层 held-out 骨架中被成功覆盖的占比，
  分层看，防"KL 达标但深层整体未覆盖"）。

---

# 附录 D — 逐文件实现清单（签名 + 必须断言）

> 下表文件名 = **落盘语言**：唯一 Python 是 `controller/train.py`，其余一律 `.ts`
> （附录 A–C 的 `.py` 代码块仅是算法规格，不是落盘文件名）。`data/dataset.*`→`data/records.ts`、
> `controller/optim.*` 并入 `train.py`，另加 `conformance/` 与 `package.json`。

| 文件 | 必须实现的公开符号 | 对应测试必须断言 |
|---|---|---|
| `schema.ts` | `Task, Step, Trajectory, Verdict, Manifest, hash_obj, task_hash` | 同对象 hash 稳定；不同 seed 同任务同 hash |
| `world/types.ts` | `t(v), TYPE_INDEX, TYPE_LIST` | `t(True)=="Bool"` 先于 Int；`TYPE_LIST` 恰 6 项 |
| `world/operators.ts` | `OPS, NODES, ROUTING, MAX_REPEAT, emod, apply_op, requires_ok, init_state, sample_value, run_plan` | `dead_end` 永不 `requires_ok`；`"any"` 通配跳过类型检查且不进 `requires_types`；`str_len` out_type=Int；确定性；`run_plan` 追加 `hist`、不写 `expected`；`emod` 非负 |
| `world/goal.ts` | `goal_ok(value, spec), Goal` | 四类目标谓词；`all` 为合取；类型不匹配返回 false 不抛异常；只读 spec、不进主臂特征 |
| `world/grammar.ts` | `LEXICON, GOAL_LEX, GOAL_TEMPLATES, LEX_OPS_BASE, render_recipe, render_goal, mention_stats` | 同 seed 渲染逐字相同；op/terminal 每算子 ≥3 义项（decoy/entry/exit 豁免）；≥1 歧义且**类型可判定**；goal 渲染无算子义项；gt/len 模板必须含数值阈值/端点；`mention_stats` 接受 op_id 或义项列表 |
  | `gen/generator.ts` | `enumerate_skeletons, signature, is_identity, dedupe_by_signature, SKELETONS, STRATA, HELDOUT_SKELETONS, VAL_SKELETONS, split_of, sample_value, instance_follow, instance_goal, sample_goal, goal_eligible, make_task, make_split, make_coverage_split, has_one_step_solution, has_shortcut` | G0.1/G0.2/G0.5；终算子不入骨架；恒等签名丢弃（R2-P0-3）；follow 极小性守卫**比长度 + 删任意步**（R2-P0-3b：depth-1 不拒；R2-P0-3 删任意步版：单步替换 + 真子序列枚举 ≤31 个，2026-09-14 落地）；goal 适格池**跳过已达标探针**（R2-P0-2b：长度不变类正确判不可达）；Int 用全域探针 → 签名去冗余可证正确；goal gold=传入骨架且 depth-1 无捷径（关死单步 echo/submit）；覆盖集每适格骨架恰 1 条；held-out 每层 ≥1 |
| `gen/splits.ts` | `_split_maps, split_of, HELDOUT_SKELETONS, VAL_SKELETONS` | 按骨架哈希分层切；每层 held-out/val ≥1；train/heldout 分布一致 |
| `gen/difficulty.ts` | `curriculumSchedule(epoch, valPassAtDepth), similarityAnneal(pool, stage)` | 课程只改训练采样配额/顺序，不改骨架枚举/切分/held-out（C.1.5）；`CURRICULUM_OFF=true` 可关作对照臂；相似性退火池内全量覆盖、端点与无条件训练可比 |
| `verify/acceptor.ts` | `accept(task, state)`, `CHANNEL` | 通道收口；错误产物必拒 |
| `verify/adversarial.ts` | `WRONG_ARTIFACTS`, `run_all() -> float` | 拒绝率 == 1.0 |
| `verify/sandbox.ts` | `run_sandboxed` | 超时返回 (False,"timeout")；rlimit 仅 POSIX |
| `teacher/oracle.ts` | `oracle_trace(task, graph)` | 末步 action==EXIT；回放穿验收 |
| `teacher/search.ts` | `state_digest, plan_bfs` | BFS 最短解 + "有解必找到"；plan 不含 EXIT；作 QA/G2.2/goal 公开规划臂；**不进训练集** |
| `adapters/llm_gateway.ts` | `chat(messages, model)`, `listFreeModels()` | Kilo 网关免费档；run 内 pin 死、失败不换模型；退避重试；失败可回喂公开原因码修复（≤2 次） |
| `data/store.ts` | `append(records)`, `load(split)`, `dedup` | 任务级去重键含 `plan_hash`（C.1 六元组）；步级键含 `task_hash` |
| `data/provenance.ts` | `manifest(...)`, `audit(...)`, `safe_action_conflict_rate(...)` | G0.4；冲突率抽样 ≤200 状态 + bounded BFS |
| `controller/slots.ts` | `build_node_slots, NODE_SLOT, HIST_SLOTS` | 基础节点占 0..21（含 exit）；追加式零碰撞；超容 fail-fast（附录 G.7）；新增节点依次追加不改 dims |
| `controller/features.ts` | `LEX_OPS_BASE, GOAL_LEX, obs_snapshot, featurize_*, OBS_DIM, ACT_DIM, FEATURE_SET`（`HIST_SLOTS`/`NODE_SLOT` 从 `slots.ts` import，不在本文件重定义） | 特征不含 expected/spec/plan；无内置 `hash()`；float32；`"any"` 不置位；OBS_DIM=732 与节点数解耦（I.2）；`hist` 用追加式槽位零碰撞、超容 fail-fast；`struct`/`hash_only` 为诊断/消融 arch |
| `controller/policy.ts` | `Policy.forward/act/save/load`（**不含 backward**——反向仅在 `train.py`，F.1/E.4） | 前向数值与 Python 侧 conformance 一致（F1/F2） |
| （`optim.*` 并入 `train.py`） | `Adam.step` | 二次函数收敛 |
| `controller/train.py` | `bc_train(D, val_D, patience, seed, batch=512, lr_schedule)`；CLI `--save-last-k K`（默认 K=5；仅拟合；**不含 dagger/correct_action**）；`--loss {ce,reinforce}`（G2.3 批量策略梯度：TS 产 trace + 终局 reward，Python 只做批量梯度）；`--head progress`（进度 critic 辅助头，默认开） | 记忆 32 例 → train acc ≥ 0.99；按 **val CE** 早停并恢复 best；落最近 K 个 checkpoint 供 TS 按 pass@1 选点；backward 数值梯度校验（含变长 mask）：`‖∇num−∇ana‖/‖∇num‖ < 1e-5` |
| `runner/graph.ts` | `GRAPH, candidates(graph,state,hist), apply_op, MAX_STEPS=12` | entry 禁入；visit 上限唯一在此实现 |
| `runner/rollout.ts` | `rollout` | 成功则 `accept === true` |
| `runner/dagger.ts` | `correctGold, dagger` | off-prefix 一律不打标；EXIT 也在偏离判定内；偏离处老师干预后**续跑**，单 rollout ≤ `maxFixes=4` |
| `world/rng.ts` | `makeRng(seed)`（mulberry32/PCG32） | 同 seed 跨进程逐位相同；无 `Math.random` |
| `world/hash.ts` | `hashObj, crc32, canonicalJson` | 规范序列化；F4 同对象恒定 |
| `eval/arms.ts` | `HeuristicArm, RandomArm, TrainedArm, PlannerArm, ContractRouteArm` | 按 style 分别报告；goal 族 Heuristic 记 N/A；PlannerArm 用公开 `plan_bfs`；ContractRouteArm 零学习零泄漏、只作对照列 |
| `eval/metrics.ts` | `pass_at_1, path_excess, steps_over_shortest, routing_acc, ci95, calibration_ece` | 手工构造样例数值正确；pass@1 带 CI；ECE 校准列（§7 承诺落地） |
| `eval/reinforce.ts` | `ReinforceArm` | 同环境同预算基线（G2.3）：TS 产 trace + 终局 reward，梯度更新在 `train.py --loss reinforce`（D 表 train.py 行） |
| `eval/scale.ts` | `run_scale(grid, seeds)` | 产出长表 + 均值±std；按 val pass@1 选终点；附幂律拟合 `S(N)=S∞(1−(N₀/N)^α)`（5 seed 给 (α,S∞) 95% CI，量化外推空间） |
| `demos/generate_demo.ts` | `main(--n --seed --out)` | 产 JSONL，行数==n；`make_task` 返回 None 时**重试至成功**（上限 `n×5` 次采样），仍不足则报错退出（不静默缺行） |
| `demos/train_demo.ts` | `main(--n --seed --out)` | 产 checkpoint + metrics.json |
| `demos/scale_demo.ts` | `main(--grid --seeds)` | 产 results.csv |
| `structure/genome.ts` | `Genome, NodeSpec, signature` | 规范形稳定；等价结构同 `signature` |
| `structure/validate.ts` | `validate(genome, graph)` | 类型闸/无环/entry 禁入/exit 可达/访问上限；违规必拒 |
| `structure/mutate.ts` | `MUTATIONS` | 变异先校验；prompt/参数变异不新增节点/边 |
| `structure/fitness.ts` | `fitness(genome, tasks), execDeterministic` | 搜索期 `execDeterministic`（I.1.7）；只用通道产物计成功；三臂同预算；含复杂度惩罚 |
| `structure/search.ts` | `search(seed, budget)` | 预算封顶；需求触发；无增益退回更简结构 |
| `structure/promote.ts` | `promote(genome, gate)` | 成功非降 + 熵界；不达标回滚；hash 链只增版本目录 |
| `tests/selftest.ts` | 全部上述断言 | 零网络零 LLM，一次跑绿 |

---

# 附录 E — 给次点模型的执行纪律（强制）

1. **禁止自行发明语义**：本附录没写的字段/算子/指标，不许加；确需扩展，先在
   `README.md` 的 "待决" 节写一行，不要先写代码。
2. **一次只做一个 Phase**：先 Phase 0（B + C.1–C.2 + D 前半），门禁全绿再动 Phase 1。
3. **先测后码**：每个文件先补 `tests/` 对应断言，再实现到断言通过。
4. **唯一口径**：`candidates` / `accept` / `hash_obj` / 特征白名单 全项目各只有一份实现，
   别处 import，不许复制粘贴改一版。
5. **特征白名单是硬红线**：`expected`、`spec`、`plan_hidden`、`plan_hash`、`seed`
   绝不能进 `obs_snapshot` 或主臂 `featurize_*`；写完用 `audit_features()` 断言。
   **唯一例外**：`struct` 诊断 arch 的 `featurize_goal_struct` 只读公开 `spec.goal`（不含
   `expected`/gold），且只服务诊断上界臂，绝不参与主臂训练、门禁或报告主指标。
6. **数值梯度校验**：`policy.backward` 必须过数值梯度测试（附录 D），不过不许训练。
7. **失败也要报告**：门禁不达标时，输出实际数字 + 失败模式，禁止调阈值或删基线。
8. **确定性**：TS 侧随机一律 `makeRng(seed)`（`world/rng.ts`，mulberry32/PCG32），
   禁用 `Math.random`；哈希一律 `hashObj`/`crc32`（`world/hash.ts`，规范序列化），禁用
   `JSON.stringify` 默认序与任何内置 `hash()`。Python 训练器若需 shuffle，用显式
   `random.Random(seed)`；**Python 不复刻 canonical JSON**，只对 `records.bin` 字节取
   sha256 写进 `train_meta`（F.2/F.2.5），F4 是 **TS 单侧**自检。
9. **零额外依赖**：TS 侧零运行时依赖（仅 devDeps `typescript`/`vitest`），IO 用 node 内置；
   Python 训练器仅用 numpy，不引入 torch（Phase 3 换 PyTorch 时才加）/matplotlib/pandas。
10. **提交前自检**：`npm --prefix experiment/DataGraphLab test`（vitest）全绿；
    Python 训练器单独 `python experiment/DataGraphLab/controller/train.py ...` 跑通。
    两者命令与输出摘要写进 `README.md`。
11. **终算子只在收尾追加**：`submit`/`check_*` 绝不入骨架枚举的采样池，
    只由 `make_task` 按族追加一次（否则 `answer` 与真值错位、G0.2 必挂）。
12. **生成与切分走骨架**：先枚举类型合法骨架，再按骨架分层实例化，最后按骨架切
    train/held-out；禁止"逐步均匀抽样 + 事后按结果切"。
13. **Phase 1–2 teacher 只 on-path oracle**：状态不在 gold 前缀上就不打标；`plan_bfs` 仅服务
    可解性 QA、G2.2 与 goal 公开规划臂；KD / 蒸馏 / 自训练飞轮推迟到 BC scaling 曲线确认瓶颈后
    （理由是标签口径，不是成本）。LLM 一律走 Kilo 网关免费档（F.5），**禁止为省成本降级/关闭 LLM**。
14. **口径唯一**：`MAX_REPEAT`（访问上限）、`MAX_STEPS=12`、`HIST_SLOTS`/`NODE_SLOT`/`OP_BUCKETS`、
    `HIST_LEN=12`、训练 `batch=512`、`LEXICON`/`GOAL_LEX`、`HELDOUT_SKELETONS`、`TYPE_LIST`（恰 6 项）
    各只有一份定义，别处 import，不许本地复制。`out_type`/`"any"` 只在 B.2 表与派生规则处定义。
15. **结构进化离线 + 需求触发**：只有能力缺口（子检查/`check_*` 在 ≥N 个 held-out 任务上失败）
    出现才准跑 `structure/search`；禁止按代/按钟生长。
16. **变异先过闸 + 能力增量**：所有变异输出先过 `structure/validate`；新增/克隆必带能力增量，
    纯 prompt/参数变异不占生长额度；等价结构按 `signature` 去重。
17. **结构晋升走接受闸与回滚**：`pass@1` 非降 + 熵 ≤ 历史最优 + 复杂度受限才晋升，
    否则整轮回滚；落盘经 GuardedStorage/EvolutionWriter，禁止旁路直写。
18. **TS 落盘纪律**：附录 A–C 的 snake_case 仅是**算法规格**；落盘一律 camelCase + 相对
    `.js` 后缀 import（符号与 D 表一一映射），注释统一中文（G.3）；禁止把规格名原样抄成
    TS 标识符。

---

# 附录 F — 语言分工与跨语言契约（训练器 = Python，其余 = TypeScript）

## F.1 分工

| 层 | 语言 | 理由 |
|---|---|---|
| `schema` / `world` / `gen` / `verify` / `teacher`（oracle、search、llm）/ `data`（store、provenance）/ `adapters/llm_gateway` / `controller/features` / 控制器**推理** / `runner`（含 `dagger.ts` 编排）/ `structure`（附录 I）/ `eval` / `demos` 编排 | **TypeScript**（ink-ts 风格：core 纯函数、JSON-in/JSON-out、零 IO；IO 收在 adapters） | 直接移植进 `ink-ts`；数据引擎与数据资产长期复用 |
| `controller/train.py`（仅 forward/backward/Adam/BC 批量拟合） | **Python 3.14 + numpy**（Phase 3 可换 PyTorch） | TS 无 autodiff/GPU/张量生态；训练器注定要能换 |

> 附录 B/C 的代码块是**算法规格**（用 Python 语法书写便于阅读），不是字面落盘语言。
> TS 侧实现必须与 B/C 数值语义逐条一致；Python 训练器只复用 C.6 的前向/反向数学。

## F.2 唯一跨语言接口（冻结，Phase 1 前不得改）

- **持久层**：`records.jsonl` 存**原始 obs**（特征代码改了不必重生成数据）：
  `{style, family, instruction, state: {x, answer, verdict}, hist: [nid...],
  candidates: [nid...], target: nid, meta}`。
- **派生层**：`records.bin`（TS 侧 `featurize` CLI 产出，派生缓存、不进版本，**v2 契约已落地**）：
  - Header：`magic 'DGLB' · u32 version=2 · u32 nrows · u32 obsDim · u32 actDim · u32 nAct(=22)`
    + nAct 个动作特征稀疏块（**ROUTING 序**，TS `featurizeAction` 预计算一次性入 header——
    这是「候选特征由 node id 确定、不重复存」的唯一落地；F.3 禁 Python 复刻特征，
    故特征表必须在 bin 内，不能靠双方各自重建）。
  - 每行：`{style, family, taskHash, stepIndex, obs 稀疏(idx:uint16[], val:float32[]),
    cand_mask:u32, target_idx:i32, progressLabel:f32, progressWeight:u32}`。
  - **`cand_mask` = 22 位全局 `ROUTING` 位掩码**（位 j ↔ `ROUTING[j]`，基础世界存于 u32）；
    **`target_idx` = 本地下标**（第 i 个置位 ↔ 候选 i，与候选展开序一致）。
  - 进度 critic 标签随行：`progressLabel = (末步 stepIndex − 本步 stepIndex)/MAX_STEPS`，
    仅完整轨迹（组内含 EXIT 行）`progressWeight=1`。
  - Python 训练器由掩码 + header 表重建每个候选的 a_i（零特征复刻）；变长候选按批内
    max m pad、掩码 -inf。
  结构进化新增节点的版本改用**变长 bitset**（I.2），表随 header 重投影。
- **出**：`weights.json`，`{arch, dims, params: {扁平数组+shape}, train_meta:
  {records_bin_sha256, code_hash, seed, epochs, epoch_snapshots?}}`。参数以 **float32 扁平数组
  + shape** 存。`epoch_snapshots` = 训练器 `--save-last-k K`（默认 K=5，钉死不降）落盘的最近
  K 个 checkpoint；TS 侧在 `VAL_SKELETONS` 上按 greedy pass@1 选点（C.5/C.8），可选对最后 K 个
  快照做 EMA/polyak 平均（β=0.99）作对照，缺省则直接用 `params`。
- **训练器契约**：`train(records_bin, val_bin, config) -> weights.json` 是进程/CLI 入口，
  负责读 `.bin`、解包、调用内部拟合函数 `bc_train(D, val_D, ...)`（C.5/D）——两者是同一
  训练器的外/内两层，不是两套口径。
- **Python 不复刻 canonical-JSON 哈希**：只对 `records.bin` 字节取 sha256 写进 `train_meta`
  ——canonical 序列化由此成为 TS 独占，避免 E.4"唯一口径"的重复实现。
- **DAgger 编排在 TS（`runner/dagger.ts`）**：rollout、gold 前缀比对、偏离标签都只需
  前向；TS 聚合好数据后调 Python 批量拟合，再加载新权重继续 rollout。
  **`correct_action`/`dagger` 不在 `train.py` 里**（`train.py` 只做批量拟合）。
  除上述文件外**无任何跨语言调用**，不共享进程/内存。

## F.2.5 TS 基础库（必须自建，禁止用平台随机/内置 hash）

| 模块 | 必须提供 | 约束 |
|---|---|---|
| `world/rng.ts` | `makeRng(seed) -> {next():u32, randint(lo,hi), choice(arr), shuffle(arr), uniform(a,b)}`，算法固定 **mulberry32/PCG32** | 禁止 `Math.random`；同 seed 跨进程/跨机器逐位相同 |
| `world/hash.ts` | `hashObj(o) -> string`（sha1 截 16）、`crc32(s) -> u32` | 纯 TS 同步实现；禁止 `JSON.stringify` 默认序——先**规范序列化**（键排序、数字格式固定、UTF-8） |

> `world/rng.ts` + `world/hash.ts` 是 G0.1 的地基：TS 标准库无可复现 RNG。
> **canonical JSON 哈希是 TS 独占**——Python 侧只对 `records.bin` 取 sha256，
> 不复刻规范序列化，从构造上消除"唯一口径"的例外。`conformance/` 只需保证
> 数字格式化边角稳定（`0.1`、`1e-7`、`1` vs `1.0`、`-0.0`、CJK），由 TS 单侧断言。

## F.3 四条防漂移门禁 F1–F4（Phase 1 必过，否则实验无效）

| 门禁 | 判定 | 阈值 |
|---|---|---|
| F1 前向一致 | 固定权重 + 固定特征，**两侧统一 float64 累加**后比 softmax 分布逐元素 | `max|Δ| < 1e-6` |
| F2 往返一致 | Python 产出 `weights.json` → TS 加载 → held-out greedy action 与 Python 版比对 | 一致率 100%；`|top1−top2| < 1e-4` 视为并列，按**索引小者**；非并列不允许分歧 |
| F3 特征单源 | 静态审计 `records.bin` 由 TS `featurize` 产出；Python 侧禁止出现 tokenize/LEXICON/mention/goal 代码 | 0 违规 |
| F4 规范序列化自检 | TS `canonicalJson` 对 `0.1 / 1e-7 / 1 vs 1.0 / -0.0 / CJK` 的哈希稳定 | 同对象恒定 |

> F1 用 **float64 累加路径**（参数/特征先转 f64）判"数学是否等价"，避免 BLAS 与 JS 循环
> 在 ≈732 维 float32 点积上的求和顺序差异被误判为错误；产品推理仍走 float32，
> 由 F2 的 argmax/并列窗口兜底。

> F1/F2 各写一份固定 fixture（几组 `(weights, obs, candidates)` 输入与期望输出）放在
> `experiment/DataGraphLab/conformance/`，两语言的测试都读它——这是防止"训练时表现好、
> 推理时悄悄错位"的唯一保险。

## F.4 升级路径

- 现在：TS 世界 + TS 推理 + numpy 训练器。
- 将来控制器变大 / 上 GPU / 换 LLM-SFT：**只替换 `train()` 实现**（numpy → PyTorch），
  `records.jsonl`、`weights.json`、TS 世界与推理、全部数据资产原样不动。
- 将来引擎内置：**可移植的是机制，不是领域**。可搬进 `ink-ts/engine/src/core/` 的只有
  契约闸 / 通道验收 / pointer 打分 / 骨架切分等**零领域词机制**；`add3`/`upper` 等领域算子
  属于实验/插件层，**不得进 core**（违反 core 零领域词铁律）。`world/*.ts` 整体留实验层。
- 别把 `train.py` 的哈希/随机口径照搬进 TS：TS 侧以 `world/rng.ts` + `world/hash.ts` 为准。

## F.5 LLM 提供方：Kilo 网关免费档（默认，禁止降级）

所有 LLM 调用（teacher、语义叶子、LLM-SFT 对照）统一走 **Kilo 网关免费档**，不因成本关闭或降级：

```
base_url: https://api.kilo.ai/api/gateway
api_key:  null（匿名免费档，Bearer 空 token 即可）
model:    从 GET /api/gateway/models 拉取，取 `:free` 的 ID；运行时刷新，勿硬编码
```

实测可用免费档（示例，非真源；每次 run 从清单刷新并 pin 一个）：

```
stepfun/step-3.7-flash:free 
nex-agi/nex-n2.5-pro:free          nex-agi/nex-n2.5-mini:free
nvidia/nemotron-3-super-120b-a12b:free   nvidia/nemotron-3-ultra-550b-a55b:free
nvidia/nemotron-3.5-lightning:free  nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
thinkingmachines/inkling-small:free       inclusionai/ling-3.0-flash-vl:free
poolside/laguna-s-2.1:free         liquid/lfm-2.5-2.6b:free
```

纪律：
- **pin 死**：每个 run 选定一个 model ID 并写进 `manifest.json`；**run 内禁止 fallback 换模型**
  （换模型 = 转移函数漂移，破坏统计平稳性）；失败就重试/该 run 作废，不偷偷换。
- **确定化**：语义叶子与 teacher 一律 `temperature=0`，并按 prompt-hash 记忆化 rollout 缓存
  ——否则 Phase 3→4 的漂移自修复曲线不可复现（G0.1 的自然延伸）。
- IO 只在 `adapters/llm_gateway.ts`（node `fetch`），core 零 IO；teacher 产物**必须过验收**才留。
- 免费档受速率/额度限制，需退避重试与并发上限；**这是延迟成本，不是金钱成本**。
- 语义叶子（Phase 3）与 teacher 同网关同 pin；对照臂与训练臂必须使用**同一 pin 的模型**。

---

# 附录 G — 注释纪律与文件规模（写码强制）

1. **代码与注释禁止计划推进字眼**：不得出现阶段编号/任务编号/进度状态/计划记号
   （如「阶段五」「计划 X」「A1」「E4」「TODO(phase2)」）。代码即最终事实。
   > 本设计稿里的阶段编号仅供阅读；落盘代码时**必须改写为纯叙述注释**。
2. **注释一律叙述口吻**：讲意图/权衡/边界（为什么这样做、代价是什么），不写"做了什么"
   的流水账；关键算法与复杂逻辑必须有意图注释（如 pointer 为何用乘法交互、
   `state_digest` 为何排除 `hist`、`emod` 为何不能用裸 `%`）。
3. **注释语言**：本仓库代码注释统一用**中文**（TS 与 Python 一致），单文件内不得混用。
4. **禁止过期注释**：注释只解释"这一段当前代码"的作用；通俗的机制功能描述只放在
   文件/模块头注，函数级注释不重复机制叙事。
5. **删除功能不留残留注释**；出现"已迁移/已删除/暂时保留"类注释时，必须同时写明
   「下轮审查请及时清理」，否则按残留清理。
6. **文件 ≤350 行**（含注释与空行）；超限即拆模块，确需例外在文件头注明理由。
   `features.ts` / `policy.ts` / `operators.ts` 最容易触线，务必按职责拆分。
7. **健壮性硬规则**：外部边界（`records.jsonl` / `weights.json` / `manifest.json`）先校验
   schema + 版本，不一致 fail-fast，**禁止静默降级**；`make_split` 配额不足抛错；标签冲突进
   quarantine；所有随机显式 seed；数值入口判 NaN/Inf。

---

# 附录 H — 算力账与优化（回答"耗不耗性能"）

## H.1 成本量级（Phase 0–2）

| 环节 | 单次成本 | 全量量级 | 结论 |
|---|---|---|---|
| 骨架枚举 | 一次 DFS（≤depth5，MAX_REPEAT=2） | 启动时一次性，约 10^4–10^5 骨架 | 可忽略 |
| 生成 + 验收 + oracle | 每任务 ~8 次纯函数变换 | 30k 任务 | 秒级，零 LLM |
| records 体积 | 原始 obs（JSONL，可读真源）→ TS featurize → `records.bin`（`obs_idx:uint16` 稀疏 float32+掩码，派生） | 30k×8 ≈ 24 万步，bin ≈ 0.15–0.25GB | 持久资产存原始 obs；bin 可重建 |
| 训练（numpy） | ~105k 参数，见 H.2 | 单次 (N=30k) 分钟级 | 非瓶颈 |
| 推理（TS） | 每决策 <1e5 MAC | held-out 统计集 ≤300/族 × seed | 可忽略 |
| search teacher | BFS 最短解（节点预算封顶） | 可解性 QA + G2.2 + goal 规划臂 | 可控 |
| LLM teacher / 语义叶子 | Kilo 网关免费档（F.5） | Phase 3 | 金钱成本≈0；成本是延迟/限流 |

## H.2 训练成本模型与必做优化

- 参数量：`Wo` 128×OBS_DIM(≈732) ≈ 94k + `Wa` 128×`ACT_DIM`(83) ≈ 11k + `w_s` 128 ≈ **≈105k 参数**。
- 样本：N=30k × ~8 步 ≈ 24 万步；30 epoch → ≈720 万步；朴素 ≈1 TFLOP 级，float32 BLAS
  下**分钟级**。

1. **动作嵌入预计算**：候选动作特征来自固定节点集（`N_ACTIONS=22`），`Z = tanh(Wa·A + ba)`（22×128）每轮前向只算
   一次，每步候选直接索引 `Z`；`Wa` 梯度按候选索引 scatter 累加。把"每候选一次 matmul"降为
   "每步 O(1) 索引"——这是最大提速点。
2. **批次编码器**：`H = tanh(O @ Wo.T + bo)`，`O` 为 (B×OBS_DIM) 稠密 float32；obs 虽稀疏但
   OBS_DIM 仅 ~732，稠密化比 gather 更快（免索引开销）。
3. **维度控制**：`HASH_DIM=256`（必要时降 128），主信息走 mention 特征。
4. **float32 + 预分配缓冲 + minibatch 512（唯一口径，见 C.5；2048 只是上限弹性）+ val 早停**。
5. **records 转一次二进制缓存**（`.bin`/`.npy`，派生数据、不进版本），用 `np.memmap` 流式读，
   避免每 epoch 解析 JSONL。

## H.3 结论

- **Phase 0–2 单机 CPU 即可完成全量 scaling 曲线**；架构不构成算力天花板。
- LLM 走 **Kilo 网关免费档**（F.5），**无金钱成本**；瓶颈是免费档速率/额度，用退避重试 +
  并发上限处理，且 teacher 产物只在验收通过后留、只在抽样上跑。**禁止为省成本降级 LLM。**
- 若将来训练变大（大网/GPU/微调）：只替换 `train.py` 为 PyTorch，records/weights/TS 世界与
  推理不动（F.4）——**天花板在训练器，不在架构**。

---

# 附录 I — 受控结构进化：推理策略 DAG（叠加在 DataGraphLab 之上）

> **定位**：不替换第 7 节的固定图 + pointer 控制器。结构层**离线**搜索「推理策略 DAG」，
> 用第 3–5 节的生成器 + 可执行验收器当适应度，产出**冻结为版本**的图交给
> `runner/graph.ts` 与 pointer 路由。进化必须是受控的：需求触发、类型闸、三臂对照、
> 成功非降 + 结构熵界、版本回滚；**禁止时钟驱动生长**（对齐
> `engine.evolution.controlled_self_evolution`、
> `corrections.engine.evolution.clock_driven_additive_no_rollback`）。

## I.1 不变量（代码层焊死）

1. 节点 = 推理操作，带 B.2 / §3.1 唯一契约（`kind/requires/when/provides/out_type`）。
2. 边 = 类型兼容信息流：`u→v` 当且仅当 `provides(u)` 命中 `requires(v)` 的类型；图**无环**。
3. `entry` 禁入（无入边）、`exit` 唯一可达终点、单节点访问 ≤ `MAX_REPEAT`（复用 B.3）。
4. 所有路径必须收在验收通道（`submit` + 按族 `check_*`），验收只读对应 `provides` 字段。
5. 基础图按版本冻结；结构产物 = 版本化 delta，可回滚（对齐
   `engine.evolution.base_graph_frozen_user_delta`）。
6. 搜索期节点走**确定性执行**（见 7）；晋升后只给**变更节点**训 adapter 并重拟合 pointer
   （`engine.evolution.modular_peft_per_node_adapter`）。
7. **确定性执行器（唯一口径）**：结构搜索期不训练策略；分支点按 `candidates` 顺序取
   **字典序首个非 EXIT 候选**（`structure/fitness.ts` 的 `execDeterministic`），accepted 即成功；
   禁止"搜索期 rollout 依赖未训策略"。晋升后重训 pointer，再用 `rollout` 复核同一张图。
8. **晋升即新 world 版本**：结构晋升必须 bump `world_version`、重算 generator/`SKELETONS`/切分，
   并重跑 G0.1–G0.6；旧版本数据/权重按 arch 隔离，不得混用（否则控制器在 A 图训练、B 图评估）。

## I.2 基因组与编码不变式

```typescript
interface NodeSpec {
  contract: Contract;                 // B.2 / §3.1 唯一口径，别处不复制
  inputs: string[];                   // 读取的产物字段（须在 requires 内）
}
interface Genome {
  nodes: NodeSpec[];
  edges: [number, number][];          // u→v 仅当 provides(u) 类型命中 requires(v)
  version: string;                    // 结构版本，晋升即递增
  signature: string;                  // 结构规范形哈希：拓扑 + 每节点契约，用于等价去重
}
```

> `Genome.signature`（结构规范形哈希）与 C.1 `signature(root, skeleton)`（算子序列的诱导
> 函数签名）**不同义**，实现时勿混用命名。

**编码不变式（结构进化的前提）**：控制器特征必须对"新增节点"稳定，否则每次晋升都作废
`weights.json`：

- `MENTION_DIM` 冻结在基础词表 `LEX_OPS_BASE`；新增节点**没有专属义项槽**，其自然语言
  表述只进 hash 词袋（新增多为既有算子的组合宏，词袋足够）。
- `hist_features` 改为**追加式稳定槽位** `NODE_SLOT`（基础节点按基础顺序占 0..21，新增节点
  依次追加；容量 `HIST_SLOTS` 内 dims 不变且**零碰撞**，比哈希桶严格更优）。
- `cand_mask` 改为**变长 bitset**（按该结构版本节点数），不再固定 22 位。
- 结构版本晋升时可为动作特征追加**图拓扑投影段**（如距 exit 距离、provides 消费关系等，
  每节点固定 `G_DIM` 维）：特征值随结构版本重投影，dims 变更走 arch fail-fast；图上下文 =
  原始 obs × world_version 的函数，F.2"可从原始 obs 重建"以 manifest 中 world_version 为准。
- `OBS_DIM/ACT_DIM` 因此与节点数无关；`weights.json` 的 `arch` 记录结构版本 + 精确 dims，
  dims/版本不符 **fail-fast**，禁止跨版本静默加载。

> 基础世界即可按本不变式实现（特征是可从原始 obs 重建的派生层，无迁移成本）；等到 Phase 4
> 才改会作废已训 weights 与已跑 scaling 点。
>
> v0（无显式边的契约世界）**不引入**拓扑投影段：候选集由契约推导，拓扑特征无对象可算且与
> 契约特征冗余（provides 消费关系/terminal 等已由 KIND/provides/类型编码表达）；Phase 4
> 显式 DAG 时代才启用。

- **种子 = 线性链** `op1→op2→…→opn→submit(+check)→exit`（现行 pipeline），作为基线臂。

## I.3 变异算子白名单（全部先过 I.1 闸，违规零代价淘汰）

- 结构：插入节点、删除节点（删后仍类型闭合）、同契约替换、边重定向、加 skip（复用早先
  产物）、加 branch（条件分叉）、加 merge（多产物扇入）、加 early-exit（验收一过即提交）、
  克隆 + 专精（**必须带能力增量**）。
- 参数/prompt 变异：允许，但**不占生长额度**（不新增节点/边）。
- 所有算子输出先过 `structure/validate`；无效基因不进入适应度评估。

## I.4 适应度与三臂

- 执行面：搜索期统一用 `execDeterministic`（I.1.7，不依赖未训策略）在 held-out 上执行，
  适应度由验收器给出（只用正确通道产物计成功）；晋升后重训 pointer，再用 `rollout` 复核同一张图。
- 三臂（同 held-out、同预算）：① 线性种子 ② 同 `|V|,|E|` 随机有效 DAG ③ 进化 DAG。
- 适应度式：`fit(G) = pass@1(G) − λ·(|V|+|E|)/|V_seed| − μ·mean_calls(G)`。
- 只认**验收通过**的成功；对抗套件（§4）前置过滤，防止结构搜索 hack 验收器。

## I.5 搜索

- 小种群 EA 或有界 beam / 贪心结构爬山；种群、代数、节点、调用预算封顶。
- 复杂度单调：无成功增益时优先更简结构（MDL）；等价结构按 `signature` 去重。
- **需求触发（唯一开跑条件）**：某族子检查/`check_*` 在 ≥N（默认 30）个 held-out 任务上
  失败，且图内重连无法修复——即出现"能力缺口"记录，才准启动结构搜索。

## I.6 接受 / 回滚闸

```
能力缺口 → 结构搜索 → 三臂适应度 → 接受闸：
  pass@1_new ≥ pass@1_old          （成功非降）
  H(structure_new) ≤ H_best        （结构熵不升，H = 度数分布熵 / 节点数代理）
  steps_over_shortest 不劣；复杂度惩罚后 fit_new > fit_old + margin
否则整轮作废并回滚；落盘由 `structure/promote.ts` 写**只增版本目录 + hash 链 + manifest 审计**
（引擎侧 GuardedStorage/EvolutionWriter 在 TS 实验层的对应物，实验层不直连 Python 引擎设施）。
```

## I.7 与既有层的关系

- 生成器/验收器 = 结构进化的**唯一适应度来源**（可执行、抗投喂、通道收口）。
- pointer 控制器 = 进化图上的**残余选择**（分支点/候选路由）；结构由其提供，控制器不反向
  改拓扑。
- 引擎层只可搬走**零领域词机制**（契约闸、结构校验、MDL 适应度、门禁晋升）；
  `add3`/`upper` 等领域算子与 DAG 基因留实验/插件层（对齐 core 零领域词铁律）。
