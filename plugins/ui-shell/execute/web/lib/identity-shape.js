// 身份读值形状归一：`config.read` / `input.read` 返回整份身份视图
// （`{active, gens, body, pins, refs, next_before}`），但调用方要的是 data body。
// 本模块只做纯形状判断，不触 DOM、不发请求。

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 身份视图 → data body；非身份视图（裸 body）原样返回。 */
export function identityBody(value) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'body') ? value.body : value
}

/**
 * 身份视图 → `active`（64 位小写 hex 或 null）。
 * 非身份视图 / `active` 形状不符 → undefined：调用方据此不注入 `expect_active`
 * （省略该键 = 不做条件校验，而 null 是「断言当前无 active」）。
 */
export function identityActive(value) {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'active')) return undefined
  const active = value.active
  return typeof active === 'string' || active === null ? active : undefined
}

/** 身份视图 → `data_gen`（`{seq,payload}` 或 null）；非身份视图 / 形状不符 → undefined。 */
export function identityDataGen(value) {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'data_gen')) return undefined
  return value.data_gen
}

/** 身份数据侧特征键：出现任一即视为数据 body，不判为代码世代回落。 */
const DATA_SIDE_KEYS = ['version', 'params', 'permission', 'ui', 'providers', 'slots']

/** 代码世代回落 body 判据：拿到的是 active（commit）def body，不是身份数据，拒写。
 * commit def body 形如 `{ tree, meta }`；只判顶层含 `tree` 会误伤顶层恰好含 `tree` 的合法数据，
 * 故要求 `tree` 为字符串且不含任一数据侧特征键。 */
export function isCodeGenFallbackBody(body) {
  if (!isRecord(body) || typeof body.tree !== 'string') return false
  for (const key of DATA_SIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) return false
  }
  return true
}
