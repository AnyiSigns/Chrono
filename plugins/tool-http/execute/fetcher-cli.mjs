// 内置 fetcher 命令：把一次抓取映射为「首行元数据 JSON + base64 响应体」，经隔离执行调用。
// 零依赖（只用 Node 内置 fetch / Buffer），不读环境变量、不写盘、不取随机。
// 契约见 README「fetcher 命令契约」：stdout 首行元数据；stderr 错误文本；退出码非 0 表示失败。

function toInt(raw, fallback) {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function parseArgs(argv) {
  const out = {
    url: '',
    method: 'GET',
    headers: {},
    timeoutMs: 30000,
    maxSize: 1048576,
    maxRedirs: 5,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--url') {
      out.url = value ?? ''
      i += 1
    } else if (key === '--method') {
      out.method = (value ?? 'GET').toUpperCase()
      i += 1
    } else if (key === '--header') {
      const raw = value ?? ''
      const colon = raw.indexOf(':')
      if (colon > 0) {
        const name = raw.slice(0, colon).trim()
        const headerValue = raw.slice(colon + 1).trim()
        if (name.length > 0) out.headers[name] = headerValue
      }
      i += 1
    } else if (key === '--timeout') {
      out.timeoutMs = toInt(value, out.timeoutMs)
      i += 1
    } else if (key === '--max-size') {
      out.maxSize = toInt(value, out.maxSize)
      i += 1
    } else if (key === '--max-redirs') {
      out.maxRedirs = toInt(value, out.maxRedirs)
      i += 1
    }
    // `--meta` 只作调用约定标记，无参数值。
  }
  return out
}

function fail(message) {
  process.stderr.write(String(message).length > 0 ? `${String(message)}\n` : 'fetch failed\n')
  process.exitCode = 1
}

/** 逐块读体，达到上限即停并标记 truncated（响应流可取消）。 */
async function readLimited(response, maxSize) {
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null
  if (reader === null) return { bytes: Buffer.alloc(0), truncated: false }
  const chunks = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    const chunk = Buffer.from(value)
    if (maxSize > 0 && total + chunk.length > maxSize) {
      const take = Math.max(0, maxSize - total)
      if (take > 0) chunks.push(chunk.subarray(0, take))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(chunk)
    total += chunk.length
  }
  return { bytes: Buffer.concat(chunks), truncated }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.url.length === 0) {
    fail('missing --url')
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    let currentUrl = opts.url
    let method = opts.method
    let response = null
    for (let redirects = 0; ; redirects += 1) {
      response = await fetch(currentUrl, {
        method,
        headers: opts.headers,
        redirect: 'manual',
        signal: controller.signal,
      })
      const status = response.status
      const location = response.headers.get('location')
      if (location !== null && status >= 300 && status < 400 && redirects < opts.maxRedirs) {
        if (response.body !== null) await response.body.cancel()
        currentUrl = new URL(location, currentUrl).toString()
        if (status === 303) method = 'GET'
        continue
      }
      break
    }
    const contentType = response.headers.get('content-type') ?? ''
    const { bytes, truncated } = await readLimited(response, opts.maxSize)
    const meta = {
      status: response.status,
      content_type: contentType,
      url: currentUrl,
      truncated,
      body_encoding: 'base64',
    }
    process.stdout.write(`${JSON.stringify(meta)}\n${bytes.toString('base64')}\n`)
  } catch (err) {
    const name = err && typeof err === 'object' ? err.name : ''
    if (name === 'AbortError') fail(`timeout after ${opts.timeoutMs}ms`)
    else fail(err && typeof err === 'object' && err.message ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }
}

await main()
