// search-index-sql 索引引擎：Node 内置 node:sqlite + FTS5（trigram 分词，兼容中英文子串）。
// 按调用帧 `env.emitter` 分命名空间（owner 列），数据落宿主注入的 CHRONO_PLUGIN_DATA 下的 index.sqlite。
// 同 URL 覆盖写（先删后插）；`fetched_at` 由 SQLite 时钟盖戳，调用方无需取时间。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isRecord } from 'plugin-sdk'
import { IndexError } from './types.ts'
import type { Json } from 'plugin-sdk'

/** 单条待入库文档：url 为身份（同 url 覆盖），其余字段可空串。 */
export interface IndexDocument {
  url: string
  title: string
  snippet: string
  source: string
  body: string
}

/** FTS5 表：title / snippet / body 入索引，owner / url / source / fetched_at 仅存储。 */
const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  owner UNINDEXED,
  url UNINDEXED,
  title,
  snippet,
  source UNINDEXED,
  fetched_at UNINDEXED,
  body,
  tokenize='trigram'
)`

/**
 * 构造 MATCH 表达式：按非字母数字切词，逐词加引号（内部引号翻倍），用 OR 连接。
 * 空查询回空串（不回结果）。转义后不会引入 FTS5 语法注入。
 */
export function toMatchQuery(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

/** 索引引擎：懒开库、WAL + busy_timeout；每个进程一份连接。 */
export class IndexEngine {
  private readonly root: string | null
  private db: DatabaseSync | null = null

  constructor(dataDir: string | null) {
    this.root = dataDir
  }

  private handle(): DatabaseSync {
    if (this.db !== null) return this.db
    if (this.root === null) {
      throw new IndexError('no_data_dir', 'CHRONO_PLUGIN_DATA is not set; declare state: durable')
    }
    mkdirSync(this.root, { recursive: true })
    const db = new DatabaseSync(join(this.root, 'index.sqlite'))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    this.db = db
    return db
  }

  /** 全文检索：bm25 升序（越低越相关）、url 升序作确定 tiebreak。 */
  search(owner: string, query: string, limit: number): Json {
    const match = toMatchQuery(query)
    if (match.length === 0) return { results: [] }
    let rows: unknown[]
    try {
      rows = this.handle()
        .prepare(
          'SELECT url, title, snippet, source, fetched_at, bm25(docs) AS score ' +
            'FROM docs WHERE owner = ? AND docs MATCH ? ORDER BY score ASC, url ASC LIMIT ?',
        )
        .all(owner, match, limit)
    } catch (err) {
      throw new IndexError('bad_query', (err as Error).message)
    }
    const results: Json[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const url = typeof row['url'] === 'string' ? row['url'] : ''
      if (url.length === 0) continue
      results.push({
        url,
        title: typeof row['title'] === 'string' ? row['title'] : '',
        snippet: typeof row['snippet'] === 'string' ? row['snippet'] : '',
        source: typeof row['source'] === 'string' ? row['source'] : '',
        fetched_at: typeof row['fetched_at'] === 'string' ? row['fetched_at'] : '',
      })
    }
    return { results: results as unknown as Json }
  }

  /** 覆盖写入一批文档（单事务全有或全无）：同 owner + url 先删后插。 */
  put(owner: string, documents: IndexDocument[]): Json {
    if (documents.length === 0) return { stored: 0 }
    const db = this.handle()
    db.exec('BEGIN IMMEDIATE')
    try {
      const remove = db.prepare('DELETE FROM docs WHERE owner = ? AND url = ?')
      const insert = db.prepare(
        "INSERT INTO docs(owner, url, title, snippet, source, fetched_at, body) " +
          "VALUES (?, ?, ?, ?, ?, datetime('now'), ?)",
      )
      let stored = 0
      for (const doc of documents) {
        remove.run(owner, doc.url)
        insert.run(owner, doc.url, doc.title, doc.snippet, doc.source, doc.body)
        stored += 1
      }
      db.exec('COMMIT')
      return { stored }
    } catch (err) {
      db.exec('ROLLBACK')
      throw new IndexError('write_failed', (err as Error).message)
    }
  }

  /** 本命名空间的文档数。 */
  stats(owner: string): Json {
    let docs = 0
    try {
      const row = this.handle().prepare('SELECT count(*) AS n FROM docs WHERE owner = ?').get(owner)
      if (isRecord(row) && typeof row['n'] === 'number') docs = row['n']
    } catch (err) {
      throw new IndexError('read_failed', (err as Error).message)
    }
    return { docs }
  }

  /** 断连 / drain：关闭连接，未落盘的 WAL 由 SQLite 收口。 */
  close(): void {
    if (this.db === null) return
    try {
      this.db.close()
    } catch {
      // 关闭失败不阻断退出
    }
    this.db = null
  }
}
