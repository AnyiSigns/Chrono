# 评审者交接提示词

> 直接把本文作为首条 prompt 喂给评审 agent。实现方那份是 `docs/handoff-implementer.md`，两文各喂各的，不混用。
>
> **先读四份文档再动手**：`docs/kernel.md`（可编码规格，判据来源）、`docs/kernel-next-steps.md`（本轮任务表）、`docs/kernel-design.md`（What/Why）、`docs/code-review.md`（评审工作方式）。
>
> 本轮实现方交付已入库：内核 `e5ae9cb`，宿主 + bench `558b114`。工作区里 `*.test.ts` 一件未动、导出面一字未增——你的公共面打法全部照旧可用。

---

## 0. 你的角色

你是**评审方**（`kernel.md` §5.4 定的角色）。三条铁律：

1. **只写 `*.test.ts`，不改实现、不为迁就实现放宽任何既有断言。** 你的 183 件基线（11 文件）在上轮 `39d222f` 就是绿的——本轮改动后仍全绿是实现方的锅（已核验），你要做的是**新增断言把本轮口径钉死**。
2. **只从 `index.ts` 导入。** 实现方没有加任何导出；计数桩按 §14 的注走模块 mock / `Object.freeze` / 键数桩三条路，不需要新机制。发现"写不出断言"= 规格缺口，回填 `kernel.md` 并当场裁决，不绕。
3. **绝对 ms / MB·s⁻¹ 不进规范文本**，只写比率与量级并注明测机（本轮实测数在 §4，附录化时守此律）。

## 1. 已核验的现场事实（省你一遍确认）

| 主张 | 核验结果 | 出处 |
|---|---|---|
| T2 落地 | `commit.form.ts:70` `note: () => true`；hasForm 第 43 行公共前置仍保证 args 非 null 非数组 ⇒ **顶层数组/字符串照样 bad_form**（实测） | `e5ae9cb` |
| T3 落地 | `journal.ts:83-106` verify 全包 try/catch，`KernelError → {ok:false,error:code}`，非 KernelError 仍抛；replay 保持抛，`@throws` 已补 `world_rev_mismatch` | `e5ae9cb` |
| T5 落地 | `journal.apply.ts:211-218` 段 1 后短路：全 `put` 且**替换后键**已在 `defs` → `ok(w,true,argsHash,[])`；含非 put / 嵌套批 / 本批内才新增的键都不短路（实测四类边界，判决字段与段 2 定论一致） | `e5ae9cb` |
| 183 基线 | typecheck / prettier / vitest 三项在 `e5ae9cb` 上全绿；测试文件零接触 | 实现方判据 |
| T6 宿主侧 | `host.ts:70` 第一份 schema def = `["g",["pins","src"]]`；门禁经 `run` 的 eval directive（entry 须已在 defs，故先有 r-2a 一步 put）；漏 `pins.src` → `missing_path` 整次作废（实测 ✓）；manifest 哈希只在 `pins`，body 无 64-hex（实测 ✓） | `558b114` |
| T4 宿主侧 | `host.ts:142` `assemble("full"│"partial"│"base_only")` = §6 三模式；partial = ①`verify([],anchorAfter(基础,快照),{world_rev})` → ②`verify(尾段,anchor)` → ③`replay(尾段,基础)`；每次 done 追一条 `snapshot` entry + `snap-<seq>.json` 本体落盘；**`rev` 存档土办法已删**（总闸第 5 条达成） | `558b114` |
| 宿主闭环 | `host.ts` → `resume` → `boot` 三命令全 ✓（真实 HTTP；partial 组装世界与 full **H(世界) 逐字节相同**） | 实现方实测 |

## 2. 你要写的测试（183 → ≥192）

### T2 · 载荷 note（6 条，§11.4"本轮新增"清单）

1. 正例：任意 JSON 对象载荷 → `ok:true`、`entry!==null`；空 `{}` 仍过（向后兼容）；顶层数组/字符串 → `bad_form`（触发点在 hasForm 公共前置，不是 note 检查——断言 reasons 即可，别锁文案）。
2. **同载荷两次 = 两条 entry**（`isNoop` 恒 false）；两条 `entryHash` 必不同（seq/prev 不同），at 可同。
3. 改载荷不改 `argsHash` → `args_hash_mismatch`——`journal.b:257`"entryHash 不读 args"的镜像。**注意**：只给非 snapshot 的 op 用此断言，见 §3 裁决点 B。
4. 不变量 16 落 §14：只含载荷 note 的链 `replay ≡ EMPTY_WORLD` 逐字节、全程 `worldRev` 不变、`Object.keys(defs).length` 与条数无关（键数桩）、同载荷两次**不吃 dup**。
5. batch 内 `note` 载荷含 `{"$n":k}` 且经 `commit` 完整形态路径（旧 `journal.b:360` 是 applyEntry 直路，不覆盖这条）。
6. 载荷 note 双跑逐字节一致。

### T3 · verify 不抛（3 条，§10.5"本轮新增" 1–3）

1. 篡改链中 `snapshot` 的 `world_rev` → verify **返回** `world_rev_mismatch`；对照例：`applyEntry` 直测同一构造仍**抛**——两口径各一例。
2. `replay(尾段, 错的基础)` **不报错**——把"不保证"写死成断言（例 = 尾段一条 `add_identity` 在真实历史上该 `id_taken`、接错基础却成功 ⇒ 链上从未被授权的世界）；同一构造 `verify(尾段, anchor)` 应 `chain_broken`。
3. 三步 `verify([],anchorAfter(基础,快照),{world_rev}) → verify(段,anchor) → replay(段,基础)` 与 full **逐字段等价**（宿主 `resume` 已实测 H(世界)相同；这条把等价性冻结进内核测试）。

### T5 · dup 短路（1 条 + 桩，§10.5"本轮新增" 4）

计数桩：同批 `H` 次数按 §14-14 口径（**按载荷字节计，entryHash 类小定长 map 各记常数 1**）：短路后 = `N`（段 1 payload 账）`+2`（聚合 + outerPos 两笔常数）；断"2N → N"时把段外两笔算成常数即成立。另断：短路批 `verdict`（ok/reasons/pos/written）与 `entry===null` 逐字段等于段 2 定论；含非 put 的混合批不短路；**同批内部自重**（键不在 `w`，靠本批第一个 put 才存在）不短路、isNoop=false——这是短路与段 2 语义等价的最锋利反例。

### T6 验收闸 · stale 红→绿（评审方的关键闸）

构造（next-steps T6）：旧世代 pin `src=K1` → `put` 改后源码 `K2` → `set_active` 新世代 ⇒ `stale(旧manifest def{pins.src=K1}, world, id) === true`。内核 `stale()` 本轮未改（§11.3 口径原样），**若 pins 写对了仍红 ⇒ 是实现 bug，回来改内核**——这一步就是那台机器的诊断用例。附带：漏 pins 的 gen/def 经 `validate` **应当通过**（内核不读 body），拒发生在宿主判据侧——宿主演示里已有两行 check（`host.ts` 门禁放行/能拒），你在公共面上把同构场景钉成断言。

## 3. 两处裁决点（发现即回填规格或记入 next-steps，别静默）

- **A · "dup/put <10%" 与设计上界冲突**：next-steps §3 总闸第 4 条与实现者交接 §5 写"复测降到 <10%"；但 `kernel-design.md` §13 写明"dup 短路的省幅上限是一半（段 1 预哈希那趟不可免，那是 argsHash 链格式）"。实测本机 B 段 dup=put 的 **40–49%**（三种规模）——落在 §13 上界内、距 10% 远。`kernel.md` 规范文本未含该数字，无需改；**改的是计划文档的期望值**，请裁决口径（或把 <10% 重新定义到"纯 apply 账"分母）。
- **B · snapshot 篡改的码序**：§20 循环里 `applyEntry` 先于 argsHash 比对 ⇒ 改 snapshot 的 `args.world_rev`（即便不同步 `argsHash`）命中 `world_rev_mismatch` 而非 `args_hash_mismatch`——实现按 §20 顺序就是这个行为（实测）。§10.4 那行"改 args 不改 argsHash → args_hash_mismatch"若泛指一切 op 会与 snapshot 相抵——**建议给该行补"非 snapshot"限定回填规格**，改实现顺序不是选项（抛点在世界自校处，前置比对反而要预哈希两次）。

## 4. 本轮实测数字（附录化候选；绝对值仅本机 i3/8.4GB·空闲1GB 口径）

| 测点 | 结果 |
|---|---|
| B 段 dup 短路 | 88% → **40–49%**（段 1 预哈希为不可免上界，§13 ✓） |
| ① 2500×20KB=50MB 声明档 | 写路 5.6s；全量审计 11.2s（=写路 ~2 倍，纯内核两趟）；cloneWorld ≈1.4ms/次@2500 |
| ② 100k×200B 载荷 note | 写路 4.2s = **42µs/条**；defs **零增长**；replay≡EMPTY、worldRev 全程不变；链上账 ≈242B/条 |
| ③④ 50k 声明 ≈ 1GB 语料 | 内核侧账 **9.1MB = 语料 0.91%**；写+审 7.8s（同语料按①档纯哈希 ≈52s + 全量克隆） |
| 宿主 partial vs full | 三步成对组装世界与全量重放 **H(世界) 逐字节相同** |

**本机跑不动的**：X10 绝对语料、② 的 1M 档真值（≈5000 defs 级内存墙）——需换 ≥16GB 机复跑，产出"比率+量级+测机"三件套。

## 5. 不许顺手做（评审侧 mirror 清单）

- 改任何非 `*.test.ts` 文件（包括 README、`experiment/`、规格）——规格回填除外，且回填必须走 §5.4"写不出断言才算缺口"的判据。
- 放宽/删除既有 183 件中的任何断言来使新实现绿。
- 为可测性要求实现方加导出 / 开关 / 桩位——§14 计数桩三条路（模块 mock、深冻结、键数桩）本轮全部够用，实现方已确认公共面零变化。
- 把 §4 的绝对 ms 抄进 `kernel.md` 规范文本。
- 重开"不许顺手做的事"（next-steps §4）已否决项——尤其别把 `dup` 短路的"判决逐字段一致"扩成"要求实现暴露内部路径"。

## 6. 判据（你跑的）

```
cd packages/kernel
npm test        # ≥192 全绿（6+3+1 为下限；不变量 16 单列则 +1）
```

外加 next-steps §3 五闸的第 1、2、3、5 条：①测试数达标且无放宽；②stale **先红后绿**（红的那次留证据——证明确有洞）；③留痕链世界不动（你正式化实现方的实测）；⑤宿主清单走 §0.4 判据问句能答对、rev 存档确已被 assemble ① 取代。第 4 条（实验复测）实现方已交数、含 §3 裁决点 A 待你裁。
