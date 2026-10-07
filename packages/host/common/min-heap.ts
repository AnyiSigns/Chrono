// 二叉最小堆：按 comparator 每次取出最小元素，push / pop 均摊 O(log n)。
// 供确定性拓扑排序（每次取当前可用的最小键）复用，替代「排序数组 + shift + 插入」的 O(n²) 扫描。

export class MinHeap<T> {
  private readonly items: T[] = []
  private readonly compare: (a: T, b: T) => number

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare
  }

  get size(): number {
    return this.items.length
  }

  push(item: T): void {
    const items = this.items
    items.push(item)
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.compare(items[index], items[parent]) >= 0) break
      ;[items[index], items[parent]] = [items[parent], items[index]]
      index = parent
    }
  }

  pop(): T | undefined {
    const items = this.items
    if (items.length === 0) return undefined
    const top = items[0]
    const last = items.pop() as T
    if (items.length === 0) return top
    items[0] = last
    let index = 0
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (left < items.length && this.compare(items[left], items[smallest]) < 0) smallest = left
      if (right < items.length && this.compare(items[right], items[smallest]) < 0) smallest = right
      if (smallest === index) break
      ;[items[index], items[smallest]] = [items[smallest], items[index]]
      index = smallest
    }
    return top
  }
}
