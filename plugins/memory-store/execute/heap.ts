// 有界最小堆：用于 top-k 部分选择（O(N·log k)），不全排序。
// `compare(a, b) < 0` 表示 a 更靠近堆顶；调用方用「较差者优先」的比较器即可让堆顶 = 当前最差。

/** 数组实现的二叉最小堆。 */
export class MinHeap<T> {
  private readonly items: T[] = []
  private readonly compare: (a: T, b: T) => number

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare
  }

  get size(): number {
    return this.items.length
  }

  peek(): T | undefined {
    return this.items[0]
  }

  push(value: T): void {
    this.items.push(value)
    this.bubbleUp(this.items.length - 1)
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    const last = this.items.pop() as T
    if (this.items.length > 0) {
      this.items[0] = last
      this.bubbleDown(0)
    }
    return top
  }

  /** 堆内元素（无序）；调用方自行按需排序。 */
  toArray(): T[] {
    return [...this.items]
  }

  private bubbleUp(start: number): void {
    let index = start
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.compare(this.items[index], this.items[parent]) >= 0) break
      this.swap(index, parent)
      index = parent
    }
  }

  private bubbleDown(start: number): void {
    let index = start
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left
      if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right
      if (smallest === index) break
      this.swap(index, smallest)
      index = smallest
    }
  }

  private swap(left: number, right: number): void {
    const temp = this.items[left]
    this.items[left] = this.items[right]
    this.items[right] = temp
  }
}
