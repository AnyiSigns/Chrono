// 生成 `execute/web/icons.v2.svg`：从 lucide-static 的 `icon-nodes.json` 抽取 §8 登记子集，
// 统一 24×24 viewBox、stroke 1.5、round cap/join、currentColor，打成 sprite。
// 用法：node plugins/ui-shell/tools/gen-icons.mjs <lucide-static 包目录>
// 生成物随包入世；本工具与 lucide-static 都是构建期依赖，运行期零依赖。

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'execute', 'web', 'icons.v2.svg')

// 登记名 → Lucide 现行名（个别图标在 Lucide 新版改过名）。
const ICONS = {
  'arrow-up': 'arrow-up',
  square: 'square',
  plus: 'plus',
  pencil: 'pencil',
  settings: 'settings',
  copy: 'copy',
  'rotate-ccw': 'rotate-ccw',
  'arrow-down': 'arrow-down',
  cpu: 'cpu',
  gauge: 'gauge',
  zap: 'zap',
  'shield-alert': 'shield-alert',
  eye: 'eye',
  ban: 'ban',
  check: 'check',
  x: 'x',
  'check-check': 'check-check',
  'alert-triangle': 'triangle-alert',
  'alert-circle': 'circle-alert',
  'pencil-line': 'pencil-line',
  'chevron-down': 'chevron-down',
  list: 'list',
  puzzle: 'puzzle',
  sparkles: 'sparkles',
  brain: 'brain',
  info: 'info',
  sun: 'sun',
  moon: 'moon',
  monitor: 'monitor',
  download: 'download',
  upload: 'upload',
  paperclip: 'paperclip',
  folder: 'folder',
  'folder-plus': 'folder-plus',
  'folder-open': 'folder-open',
  'chevron-right': 'chevron-right',
  'more-horizontal': 'ellipsis',
  search: 'search',
  'trash-2': 'trash',
  'git-branch': 'git-branch',
  'undo-2': 'undo-2',
}

// 手绘图标：Lucide 子集里没有（或语义不合）的登记名 → 24×24 viewBox 内的子元素标记串。
// 手工绘制的部分与 Lucide 同规格（stroke 1.5、round cap/join、currentColor），随 sprite 一同生成。
const CUSTOM = {
  // 「新建对话」：开口圆环（缺口在右）内嵌加号 —— 开口暗示「正在开启一段新会话」。
  'chat-plus': '<path d="M19.8 9.6A8 8 0 1 0 20 13.4"/><path d="M12 8.6v5.6"/><path d="M9.2 11.4h5.6"/>',
  // 侧栏收/展：胶囊竖条=侧栏宽度，箭头=位移方向；两态仅镜像，视觉成对。
  'panel-collapse': '<rect width="4.5" height="15" x="4" y="4.5" rx="2.25"/><path d="m16.5 9.5-3.5 2.5 3.5 2.5"/>',
  'panel-expand': '<rect width="4.5" height="15" x="15.5" y="4.5" rx="2.25"/><path d="m7.5 9.5 3.5 2.5-3.5 2.5"/>',
  // 推理卡片：脑波折线。静态态一笔到底；live 态用 pathLength 归一化 + dasharray 让亮点沿波形循环跑。
  // 动画写在 symbol 内的 <style>：sprite 经 <use> 引入时，其样式只作用于影子树，不污染页面。
  'think-wave': '<path d="M3 12h2.5l2-5 3 10 2.5-7 1.5 2H21"/>',
  'think-wave-live':
    '<style>#chrono-think-run{animation:chrono-think-dash 1.5s linear infinite}' +
    '@keyframes chrono-think-dash{to{stroke-dashoffset:-100}}' +
    '@media (prefers-reduced-motion: reduce){#chrono-think-run{animation:none}}' +
    '</style>' +
    '<path id="chrono-think-run" pathLength="100" d="M3 12h2.5l2-5 3 10 2.5-7 1.5 2H21" ' +
    'style="stroke-dasharray:9 91"/>',
}

const VOID_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])

function serializeNode([tag, attrs]) {
  const parts = []
  for (const [key, value] of Object.entries(attrs)) {
    parts.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`)
  }
  const body = parts.length > 0 ? ` ${parts.join(' ')}` : ''
  return VOID_TAGS.has(tag) ? `<${tag}${body}/>` : `<${tag}${body}></${tag}>`
}

function serializeLucide(name, lucideName, nodes, missing) {
  const node = nodes[lucideName]
  if (node === undefined) {
    missing.push(`${name}(${lucideName})`)
    return undefined
  }
  return node.map(serializeNode).join('')
}

function main() {
  const pkgDir = process.argv[2]
  if (pkgDir === undefined) {
    process.stderr.write('用法：node gen-icons.mjs <lucide-static 包目录>\n')
    process.exitCode = 1
    return
  }
  const nodes = JSON.parse(readFileSync(join(pkgDir, 'icon-nodes.json'), 'utf8'))
  const symbols = []
  const missing = []
  const entries = { ...ICONS, ...CUSTOM }
  for (const [name, value] of Object.entries(entries)) {
    const inner = value in CUSTOM
      ? CUSTOM[value]
      : serializeLucide(name, value, nodes, missing)
    if (inner === undefined) continue
    symbols.push(
      `  <symbol id="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`,
    )
  }
  const svg = [
    '<!-- icons.v2.svg —— 线性图标 sprite（Lucide 按需子集，MIT；少数为手绘，同规格）。',
    '     24×24 viewBox、stroke 1.5、round cap/join、currentColor；业务插件以',
    '     <use href="/assets/icons.v2.svg#<name>"> 引用，禁止内嵌图标或 emoji。 -->',
    '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">',
    ...symbols,
    '</svg>',
    '',
  ].join('\n')
  writeFileSync(OUT, svg, 'utf8')
  process.stdout.write(`wrote ${symbols.length} symbols -> ${OUT}\n`)
  if (missing.length > 0) process.stdout.write(`missing: ${missing.join(', ')}\n`)
}

main()
