// storage-sql 存储引擎：按 owner 分库（一 owner 一份 SQLite 文件），WAL + busy_timeout。
// 引擎 / schema / 迁移 / 事务全归本插件；宿主不读、不校验、不迁移、不解释目录内容。
// 命名空间只来自调用帧 `env.emitter`（宿主填写），不读调用方自报的任何 namespace 参数。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BadArgsError, StoreError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 单次调用载荷上限：大字节不入帧，二进制走 host.asset 后只把引用存进来。 */
export const MAX_PAYLOAD_BYTES = 256 * 1024

/** owner 名 = 身份名，宿主已保证安全单段；此处再校验一遍，避免自造文件路径。 */
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const COLUMN_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATETIME'])

interface Migration {
  version: number
  up: (db: DatabaseSync) => void
}

/** 启动迁移表：版本只增不改；每个版本一个幂等步骤，`PRAGMA user_version` 记进度。 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS _chrono_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
      db.prepare('INSERT OR IGNORE INTO _chrono_meta (k, v) VALUES (?, ?)').run('engine', 'sqlite')
    },
  },
]

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把引擎返回的值收敛成帧可承载的 JSON：大整数转 number，二进制拒绝（走资产）。 */
function toJsonValue(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    if (!Number.isSafeInteger(asNumber)) {
      throw new StoreError('integer_too_large', 'integer exceeds the safe range; store it as text')
    }
    return asNumber
  }
  if (value instanceof Uint8Array) {
    throw new StoreError('blob_not_allowed', 'binary columns are not supported; store bytes via host.asset and keep the reference')
  }
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') {
    const out: Rec = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toJsonValue(item)
    return out
  }
  throw new StoreError('unsupported_value', `cannot serialize ${typeof value}`)
}

/** 迁移在独占事务内执行：任一步失败整步回滚，版本不前进。 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const current = typeof row?.user_version === 'number' ? row.user_version : 0
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

/** 命名空间（owner）解析：只认调用帧 `env.emitter`；取不到时归宿主自身 `host`。 */
export function resolveOwner(emitter: Json): string {
  const owner = typeof emitter === 'string' && emitter.length > 0 ? emitter : 'host'
  if (owner.length > 128 || owner === '.' || owner === '..' || !OWNER_NAME.test(owner)) {
    throw new BadArgsError(`unsafe emitter name: ${owner}`)
  }
  return owner
}

function requireIdentifier(value: Json | undefined, where: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new BadArgsError(`${where} must match ${IDENTIFIER}`)
  }
  return value
}

function scalarLiteral(value: Json): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BadArgsError('default must be a finite number')
    return String(value)
  }
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  throw new BadArgsError('default must be a scalar')
}

function columnDef(raw: Json, index: number): string {
  if (!isRec(raw)) throw new BadArgsError(`columns[${index}] must be an object`)
  const name = requireIdentifier(raw['name'], `columns[${index}].name`)
  const type = raw['type']
  if (typeof type !== 'string' || !COLUMN_TYPES.has(type.toUpperCase())) {
    throw new BadArgsError(`columns[${index}].type must be one of ${[...COLUMN_TYPES].join(', ')}`)
  }
  const parts = [`"${name}" ${type.toUpperCase()}`]
  if (raw['primaryKey'] === true) parts.push('PRIMARY KEY')
  if (raw['notNull'] === true) parts.push('NOT NULL')
  if (raw['unique'] === true) parts.push('UNIQUE')
  if (raw['default'] !== undefined) parts.push(`DEFAULT ${scalarLiteral(raw['default'])}`)
  return parts.join(' ')
}

function requireSql(value: Json | undefined, readOnly: boolean): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadArgsError('sql must be a non-empty string')
  }
  if (readOnly && !/^\s*(SELECT|WITH)\b/i.test(value)) {
    throw new BadArgsError('query only accepts SELECT / WITH statements')
  }
  return value
}

function paramsOf(value: Json | undefined): Json[] | Rec | null {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return value
  if (isRec(value)) return value
  throw new BadArgsError('params must be an array or object')
}

function prepare(db: DatabaseSync, sql: string) {
  try {
    return db.prepare(sql)
  } catch (err) {
    throw new StoreError('bad_sql', (err as Error).message)
  }
}

function runAll(stmt: ReturnType<DatabaseSync['prepare']>, params: Json[] | Rec | null): unknown[] {
  const rows = params === null ? stmt.all() : Array.isArray(params) ? stmt.all(...params) : stmt.all(params)
  return rows as unknown[]
}

function runWrite(
  stmt: ReturnType<DatabaseSync['prepare']>,
  params: Json[] | Rec | null,
): { changes: unknown; lastInsertRowid: unknown } {
  const info = params === null ? stmt.run() : Array.isArray(params) ? stmt.run(...params) : stmt.run(params)
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
}

/** 每个 owner 一份连接；`dataDir` 由宿主经 `CHRONO_PLUGIN_DATA` 注入。 */
export class SqlEngine {
  private readonly root: string | null
  private readonly dbs = new Map<string, DatabaseSync>()

  constructor(dataDir: string | null) {
    this.root = dataDir
  }

  private db(owner: string): DatabaseSync {
    const cached = this.dbs.get(owner)
    if (cached !== undefined) return cached
    if (this.root === null) {
      throw new StoreError('no_data_dir', 'CHRONO_PLUGIN_DATA is not set; declare state: durable')
    }
    mkdirSync(this.root, { recursive: true })
    const db = new DatabaseSync(join(this.root, `${owner}.sqlite`))
    // WAL + busy_timeout：新旧实例可并存打开同一份库，写冲突按超时重试而非立即失败。
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
    this.dbs.set(owner, db)
    return db
  }

  createTable(owner: string, args: Rec): Json {
    const name = requireIdentifier(args['name'], 'name')
    const columns = args['columns']
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new BadArgsError('columns must be a non-empty array')
    }
    const defs = columns.map((column, index) => columnDef(column, index))
    this.db(owner).exec(`CREATE TABLE IF NOT EXISTS "${name}" (${defs.join(', ')})`)
    return { table: name }
  }

  query(owner: string, args: Rec): Json {
    const sql = requireSql(args['sql'], true)
    const params = paramsOf(args['params'])
    const db = this.db(owner)
    const rows = runAll(prepare(db, sql), params)
    return { rows: rows.map(toJsonValue) }
  }

  write(owner: string, args: Rec): Json {
    const sql = requireSql(args['sql'], false)
    const params = paramsOf(args['params'])
    const db = this.db(owner)
    const info = runWrite(prepare(db, sql), params)
    return { changes: toJsonValue(info.changes), lastInsertRowid: toJsonValue(info.lastInsertRowid) }
  }

  batch(owner: string, args: Rec): Json {
    const statements = args['statements']
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new BadArgsError('statements must be a non-empty array')
    }
    const db = this.db(owner)
    db.exec('BEGIN IMMEDIATE')
    try {
      const results: Json[] = []
      for (let index = 0; index < statements.length; index += 1) {
        const item = statements[index]
        if (!isRec(item)) throw new BadArgsError(`statements[${index}] must be an object`)
        const sql = requireSql(item['sql'], false)
        const info = runWrite(prepare(db, sql), paramsOf(item['params']))
        results.push({ changes: toJsonValue(info.changes), lastInsertRowid: toJsonValue(info.lastInsertRowid) })
      }
      db.exec('COMMIT')
      return { count: results.length, results }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  listTables(owner: string): Json {
    const rows = runAll(
      prepare(
        this.db(owner),
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_chrono\\_%' ESCAPE '\\' ORDER BY name",
      ),
      null,
    )
    const tables = rows
      .map((row) => (isRec(row) ? row['name'] : null))
      .filter((name): name is string => typeof name === 'string')
    return { tables }
  }

  info(owner: string): Json {
    const db = this.db(owner)
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const tables = this.listTables(owner) as { tables: Json[] }
    return {
      schemaVersion: typeof row?.user_version === 'number' ? row.user_version : 0,
      tables: tables.tables,
    }
  }

  /** 丢弃本 owner 的命名空间：删光其全部表并回收空间；宿主不认识命名空间语义，不代劳。 */
  dropNamespace(owner: string): Json {
    const db = this.db(owner)
    const tables = (this.listTables(owner) as { tables: string[] }).tables
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table}"`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    db.exec('VACUUM')
    return { dropped: tables.length }
  }

  /** 断连 / drain：关闭全部连接，未落盘的 WAL 由 SQLite 收口。 */
  close(): void {
    for (const db of this.dbs.values()) {
      try {
        db.close()
      } catch {
        // 关闭失败不阻断退出
      }
    }
    this.dbs.clear()
  }
}
