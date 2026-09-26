# toy-term

数据身份 toy 包：验证「糖化源 `terms.src/` → 工具链构建 → `terms/` 产物入世 → `eval` 跑通」这条通路。

- `terms.src/best.json`：糖化判定源（在候选列表里按 `score` 取最大者的 `id`）。
- `terms/best.json`（及内联 step 生成的 `terms/__gen/*.json`）：工具链编译产物，随包入世。
- `plugin.json.build`：`node ../../../toolchain/build.ts .`（宿主只执行、不解释；本包无执行件，故运行期不跑）。
- `.worldignore` 排除 `terms.src/` 与 `test/`。

构建：

```
node ../../../toolchain/build.ts .
```
