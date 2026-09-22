import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardInboundRequest,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
} from '../execute/inbound-guard.js'

function request(method, headers) {
  return { method, headers }
}

test('Host 只认本机同端口写法', () => {
  assert.equal(isAllowedHost('127.0.0.1:8794', 8794), true)
  assert.equal(isAllowedHost('localhost:8794', 8794), true)
  assert.equal(isAllowedHost('evil.example:8794', 8794), false)
  assert.equal(isAllowedHost('127.0.0.1:1', 8794), false)
  assert.equal(isAllowedHost(undefined, 8794), false)
})

test('Origin 只认同源写法', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:8794', 8794), true)
  assert.equal(isAllowedOrigin('http://localhost:8794', 8794), true)
  assert.equal(isAllowedOrigin('http://evil.example', 8794), false)
  assert.equal(isAllowedOrigin('null', 8794), false)
})

test('写方法要求 JSON 体', () => {
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true)
  assert.equal(isJsonContentType('text/plain'), false)
  assert.equal(isJsonContentType(undefined), false)
})

test('GET 带本机 Host、无 Origin 放行', () => {
  const rejection = guardInboundRequest(
    request('GET', { host: '127.0.0.1:8794' }),
    8794,
  )
  assert.equal(rejection, null)
})

test('Host 伪造被拒', () => {
  const rejection = guardInboundRequest(
    request('GET', { host: 'evil.example:8794' }),
    8794,
  )
  assert.equal(rejection.status, 403)
  assert.equal(rejection.code, 'forbidden_host')
})

test('写方法缺失 Origin 被拒', () => {
  const rejection = guardInboundRequest(
    request('POST', { host: '127.0.0.1:8794', 'content-type': 'application/json' }),
    8794,
  )
  assert.equal(rejection.code, 'forbidden_origin')
})

test('写方法非 JSON 体被拒', () => {
  const rejection = guardInboundRequest(
    request('POST', {
      host: '127.0.0.1:8794',
      origin: 'http://127.0.0.1:8794',
      'content-type': 'text/plain',
    }),
    8794,
  )
  assert.equal(rejection.status, 415)
})
