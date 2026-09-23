// lightbox 状态机（纯函数）：缩放 / 平移 / 双击 / 关闭。
// 缩放范围 0.2×–4×；缩放中心 = 指针位置；关闭重置并交调用方归还焦点（DOM 层）。

export const MIN_SCALE = 0.2
export const MAX_SCALE = 4

export interface LightboxState {
  open: boolean
  src: string | null
  alt: string
  scale: number
  tx: number
  ty: number
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** 创建一份 lightbox 视图状态；所有方法返回当前快照。 */
export function createLightboxState(): {
  get(): LightboxState
  open(src: string, alt?: string): LightboxState
  close(): LightboxState
  zoomAt(nextScale: number, pointerX?: number, pointerY?: number): LightboxState
  toggleDoubleClick(pointerX?: number, pointerY?: number): LightboxState
  pan(dx: number, dy: number): LightboxState
  setPan(x: number, y: number): LightboxState
} {
  let state: LightboxState = { open: false, src: null, alt: '', scale: 1, tx: 0, ty: 0 }

  const api = {
    get(): LightboxState {
      return { ...state }
    },
    open(src: string, alt = ''): LightboxState {
      state = { open: true, src, alt, scale: 1, tx: 0, ty: 0 }
      return api.get()
    },
    close(): LightboxState {
      state = { ...state, open: false, src: null, scale: 1, tx: 0, ty: 0 }
      return api.get()
    },
    /** 以指针位置为缩放中心。 */
    zoomAt(nextScale: number, pointerX = 0, pointerY = 0): LightboxState {
      const scale = clampScale(nextScale)
      const ratio = scale / state.scale
      state.tx = pointerX - ratio * (pointerX - state.tx)
      state.ty = pointerY - ratio * (pointerY - state.ty)
      state.scale = scale
      return api.get()
    },
    /** 双击 1× ↔ 2×。 */
    toggleDoubleClick(pointerX = 0, pointerY = 0): LightboxState {
      return api.zoomAt(state.scale > 1 ? 1 : 2, pointerX, pointerY)
    },
    pan(dx: number, dy: number): LightboxState {
      state.tx += dx
      state.ty += dy
      return api.get()
    },
    setPan(x: number, y: number): LightboxState {
      state.tx = x
      state.ty = y
      return api.get()
    },
  }
  return api
}
