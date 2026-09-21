// 生成 `execute/web/icons.v1.svg`：从 lucide-static 的 `icon-nodes.json` 抽取 §8 登记子集，
// 统一 24×24 viewBox、stroke 1.5、round cap/join、currentColor，打成 sprite。
// 用法：node plugins/ui-shell/tools/gen-icons.mjs <lucide-static 包目录>
// 生成物随包入世；本工具与 lucide-static 都是构建期依赖，运行期零依赖。

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'execute', 'web', 'icons.v1.svg')

// 登记名（ui-design §8）→ Lucide 现行名（个别图标在 Lucide 新版改过名）。
const ICONS = {
  'arrow-up': 'arrow-up',
  square: 'square',
  plus: 'plus',
  pencil: 'pencil',
  settings: 'settings',
  copy: 'copy',
  'rotate-ccw': 'rotate-ccw',
  'panel-left': 'panel-left',
  'panel-left-close': 'panel-left-close',
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

const VOID_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])

function serializeNode([tag, attrs]) {
  const parts = []
  for (const [key, value] of Object.entries(attrs)) {
    parts.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`)
  }
  const body = parts.length > 0 ? ` ${parts.join(' ')}` : ''
  return VOID_TAGS.has(tag) ? `<${tag}${body}/>` : `<${tag}${body}></${tag}>`
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
  for (const [name, lucideName] of Object.entries(ICONS)) {
    const node = nodes[lucideName]
    if (node === undefined) {
      missing.push(`${name}(${lucideName})`)
      continue
    }
    const inner = node.map(serializeNode).join('')
    symbols.push(
      `  <symbol id="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`,
    )
  }
  const svg = [
    '<!-- icons.v1.svg —— 线性图标 sprite（Lucide 按需子集，MIT）。',
    '     24×24 viewBox、stroke 1.5、round cap/join、currentColor；业务插件以',
    '     <use href="/assets/icons.v1.svg#<name>"> 引用，禁止内嵌图标或 emoji。 -->',
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
