// lightbox 状态机（纯函数）：缩放 / 平移 / 双击 / 关闭。
// 缩放范围 0.2×–4×；缩放中心 = 指针位置；关闭重置并交调用方归还焦点（DOM 层）。

export const MIN_SCALE = 0.2
export const MAX_SCALE = 4

function clampScale(scale) {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** 创建一份 lightbox 视图状态；所有方法返回当前快照。 */
export function createLightboxState() {
  let state = { open: false, src: null, alt: '', scale: 1, tx: 0, ty: 0 }

  const api = {
    get() {
      return { ...state }
    },
    open(src, alt = '') {
      state = { open: true, src, alt, scale: 1, tx: 0, ty: 0 }
      return api.get()
    },
    close() {
      state = { ...state, open: false, src: null, scale: 1, tx: 0, ty: 0 }
      return api.get()
    },
    /** 以指针位置为缩放中心。 */
    zoomAt(nextScale, pointerX = 0, pointerY = 0) {
      const scale = clampScale(nextScale)
      const ratio = scale / state.scale
      state.tx = pointerX - ratio * (pointerX - state.tx)
      state.ty = pointerY - ratio * (pointerY - state.ty)
      state.scale = scale
      return api.get()
    },
    /** 双击 1× ↔ 2×。 */
    toggleDoubleClick(pointerX = 0, pointerY = 0) {
      return api.zoomAt(state.scale > 1 ? 1 : 2, pointerX, pointerY)
    },
    pan(dx, dy) {
      state.tx += dx
      state.ty += dy
      return api.get()
    },
    setPan(x, y) {
      state.tx = x
      state.ty = y
      return api.get()
    },
  }
  return api
}
