# UI 客户端半边契约

浏览器侧 UI 插件的客户端半边（slot 应用）统一收进壳的单一 React 运行时：壳提供唯一 vendor 运行时、
slot 注册表与错误边界；插件客户端半边是一段注册进命名 slot 的模块，业务状态住在 React-free store。
本文是该契约的单一来源，壳实现见 `plugins/ui-shell/execute/web/lib/slots.js`，类型见 `types/ui-contract.d.ts`。

## 模块契约

客户端半边源码为 `execute/web/entry.tsx`，导出：

```tsx
import type { SlotContext } from '@chrono/ui-contract'

export const contract = '2'

export function register(ctx: SlotContext): void {
  ctx.slots.register({ name: 'main' }, App)
}
```

- `ctx` = 壳 api + `pluginId` + `useStore` + `slots`（完整形状见 `types/ui-contract.d.ts`）。
- `ctx.slots.register(target, Component)`：`target` 为 slot 名或 `{ name, children }`。
  顶层 slot 为 `sidebar` / `main` / `dock` / `composer` / `topbar` / `overlay`；
  `children` 声明本组件提供的子 slot，组件内用 `ctx.slots.Outlet` 落位。
- 壳对每个注册组件包一层错误边界：组件抛错只坏本 slot，渲染占位卡 + 重试。
- 壳侧唯一状态集成点是 `ctx.useStore`（`useSyncExternalStore` 绑定）。
  `useStore(store)` 返回快照；`useStore(store, selector)` 返回投影，selector 必须返回稳定引用或原始值。

## 状态

业务状态住 React-free store：`{ getSnapshot(), subscribe(listener), commit(next, meta?) }`。
`ui-chat` 的 `execute/web/thread-store.js` 是范例（快照 + 有序增量 + 定稿替换）。
React 只渲染，不持业务态；组件不各自 fetch 全量。

## 叶子渲染：留纯函数、换 DOM 层

被单测覆盖的纯模块**原样保留**，且**禁止 import react**（可 grep 断言）：
markdown / 消毒、detail 渲染、工具卡视图模型、parts 视图模型、历史还原、窗口化、群聊 / 工作流视图模型、
日期分隔、usage、copy、文案表、store fold。

被替换的是其上的 DOM 构建层：原 `render-dom` / `dom`（`el` / `icon` / `iconButton`）退休，改为 React 组件。
样式仍由插件自持：壳不提供插件 CSS 路由，组件内注入 `<style>`（与原 `styles.js` 的注入等价，只是挂到组件树上）。
组件吃纯模块产出的视图模型（vm），不就地拼字符串、
不重写格式化逻辑；新格式加到纯模块并补测。

- markdown 正文：`Markdown` 组件内部仍调 `sanitizeHtml(renderMarkdown(text))`，用
  `dangerouslySetInnerHTML` 注入。**全仓只允许这一个组件使用 `dangerouslySetInnerHTML`。**
- 流式与定稿共用同一个 `Markdown` 组件（同一管线）。
- 工具卡 detail 按 `detailViewModel` 的 `kind` 分支渲染；live 工具输出取 store 在途回合的 chunks。
- markdown / innerHTML 内的图片点击，在容器上做事件委托（innerHTML 节点不走 React 事件）。

## 构建与产物

- 源码 `.tsx` / `.ts`；叶子纯模块从 `.js` 迁到 `.ts`（测试导入路径由 `.js` 改 `.ts`，**断言不动**）。
- 插件自带构建：`plugin.json.build` 声明依赖安装 + 构建步骤，产物落 `execute/web/dist/entry.js`。
  `build` 的 args 白名单为 `[A-Za-z0-9_./:@,+-]`，**不得含 `=`**；而 esbuild CLI 的字符串选项
  （`--format` / `--outfile` / `--external` 等）必须写成 `--opt=value` 才合法，二者冲突。
  故构建步骤用 `{ "cmd": "node", "args": ["execute/build.mjs"] }`，脚本内调 esbuild JS API，
  既避开令牌限制，也不依赖 CLI 参数形态。
- 产物必须 `externalize` 壳 vendor：`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` /
  `use-sync-external-store` / `use-sync-external-store/shim`；单文件输出，不做 code splitting。
- `.worldignore` 必须新增 `execute/web/dist/`：产物入世会污染内容哈希、触发无意义换代。
- 产物是世代内可重算产物，不跨代共享、不当持久层。

## 交付路径：插件自产自交付

产物被 `.worldignore` 排除，`host.source.read`（只读世界树）读不到，故客户端半边由插件自己的服务交付：

- 插件服务保留 stdio 帧循环，新增只读命令 `<id>.client.read`（entry term eff 到自身同名方法）；
  方法参数 `{ path }`，返回 `{ path, text }`。**必须做路径穿越防护**：只接受包内相对 `.js` 路径，
  拒绝绝对路径 / 盘符 / 反斜杠 / `..` / 空段。
- 壳 `uiSource` 经 `bridge.command('<id>.client.read', { path })` 取字节并缓存，以
  `/assets/ui/<id>.js` 同源服务（`cache-control: no-store`）；失效沿用 `identity.changed` 且
  `kind === 'code'` 的口径。
- 宿主零改动：只按名路由，不读产物。

## 服务半边清理

客户端半边改由插件自交付后，插件的 HTTP 面作废，删除：
`execute/http-server.*`、`execute/port.*`、`execute/routes.*`、`execute/static.*`、`execute/inbound-guard.*`；
`plugin.json` 去掉 `"exclusive": ["port"]`。保留 `main` / `inbound` / `bridge` / `frames` / `root` /
`types` / `methods` / `plan` / `port-link` 与 `terms/`、`schema/`。

## 类型门禁

每个插件新增 `tsconfig.json`（`include` 只含 `execute/web`），`paths` 指到 `@chrono/ui-contract`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowJs": true,
    "checkJs": false,
    "allowImportingTsExtensions": true,
    "baseUrl": ".",
    "paths": { "@chrono/ui-contract": ["../../types/ui-contract.d.ts"] }
  },
  "include": ["execute/web/**/*.ts", "execute/web/**/*.tsx"]
}
```

`package.json` 增 `"typecheck": "tsc --noEmit"`。契约类型只用 `import type` 引入（esbuild 会擦除，
不产生运行期依赖）；误用值导入会在构建期失败，这是有意的护栏。

## 测试口径

- 纯模块单测**原样保留**（含 store fold），导入路径随扩展名改 `.ts`。
- 删除断言已删除实现（路由 / 端口 / 静态白名单 / http-server / inbound-guard）的测试与步骤。
- 新增：`<id>.client.read` 的路径穿越防护与正常读回；`entry.tsx` 导出 `contract` 与 `register`。
- 客户端半边不再导出 `mount`。
