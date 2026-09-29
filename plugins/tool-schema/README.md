# tool-schema（工具声明 schema 方言原语）

工具声明 `argsSchema` 方言（JSON Schema 白名单子集）与 `caps` 形状的机械校验原语。
被上层 `tool-registry` / `tool-dispatch` 经反向 `port.call` 消费；自身无反向调用、不读投影、不写世界。

- 身份：`tool-schema`
- 能力类 / 方法：`tool-schema` → `normalize-decl` / `validate-args` / `normalize-caps`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`tool-schema.json`）
- `pins`：无（`"pins": {}`；无宿主 / 跨身份依赖）
- 状态档：`recomputable`（无本地持久状态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## 方法

| 方法             | 入参                 | 返回                    | 行为                                                                                                      |
| ---------------- | -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `normalize-decl` | `{schema, lenient?}` | `{ok, message, schema}` | 严格：白名单内校验，白名单外关键词 / 形态非法 → `ok:false`；宽松：剥掉白名单外关键词，只净化不拒          |
| `validate-args`  | `{schema, value}`    | `{ok, message}`         | 用同一方言校验 `value`：`type` / `enum` / `const` / 数值 / 码点长度 / `required` / `additionalProperties` |
| `normalize-caps` | `{caps, lenient?}`   | `{ok, message, caps}`   | 归一 `{fs:{read,write}, net}` 对象形；布尔 `false` net → `"none"`；数值上限为非负数                       |

- 白名单关键词：`type` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` /
  `minimum` / `maximum` / `minItems` / `maxItems` / `minLength` / `maxLength`；注记 `title` / `description` /
  `default` / `examples` 允许出现但不参与校验。
- 纯函数：不取时间 / 随机，同输入同输出；错误作数据（`ok:false` + 可读 `message`），不抛未捕获错误。

## 边界

- 不做：目录装配 / 去重 / 文案（归 `tool-registry`）/ 批派发（归 `tool-dispatch`）。
- 不写世界、不读投影、无命令面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test    # 协议级 + 纯函数级测试（node --test）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
