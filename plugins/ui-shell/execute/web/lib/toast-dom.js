// toast 容器增量同步：按条目 id 复用已有节点，只对差集增删。
// 整表重建会销毁 hover 中的节点——旧节点不再收到 mouseleave，队列里的暂停项会永久停留；
// 复用节点同时保住焦点，避免列表变化时丢焦。

/**
 * 创建 toast 渲染器。
 * @param {{ appendChild: Function }} root 容器
 * @param {(item: object) => object} createCard 按条目构造卡片节点
 * @param {(id: string) => void} [onRemove] 节点被移除时的回调（供调用方复位 hover 暂停）
 */
export function createToastRenderer(root, createCard, onRemove) {
  const cards = new Map()
  return {
    /** 按当前可见列表同步节点；新增项追加在末尾，消失项移除并回调。 */
    render(items) {
      const seen = new Set()
      for (const item of items) {
        seen.add(item.id)
        if (cards.has(item.id)) continue
        const card = createCard(item)
        cards.set(item.id, card)
        root.appendChild(card)
      }
      for (const [id, card] of [...cards]) {
        if (seen.has(id)) continue
        cards.delete(id)
        card.remove()
        if (typeof onRemove === 'function') onRemove(id)
      }
    },
  }
}
