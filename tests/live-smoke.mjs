import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.env.ROUTER_GO_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '9router-go')
const endpoint = process.env.ROUTER_GO_URL ?? 'http://127.0.0.1:20130'
if (new URL(endpoint).hostname !== '127.0.0.1') throw new Error('Live smoke only accepts a loopback sidecar')
const password = (await readFile(join(root, 'initial-password'), 'utf8')).trim()
const health = await fetch(`${endpoint}/health`)
assert.equal(health.status, 200)
assert.deepEqual(await health.json(), { status: 'ok' })
const login = await fetch(`${endpoint}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
})
assert.equal(login.status, 200, `Dashboard login: HTTP ${login.status}`)
const cookie = login.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie, 'Dashboard did not issue a session cookie')
const created = await fetch(`${endpoint}/api/keys`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ name: 'dsh-9router-go integration smoke' }),
})
assert.equal(created.status, 200, `API key creation: HTTP ${created.status}`)
const key = await created.json()
try {
  const models = await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` } })
  assert.equal(models.status, 200, `Authenticated models: HTTP ${models.status}`)
  const catalog = await models.json()
  assert.ok(Array.isArray(catalog.data))
  console.log(`9router-go /health OK; Dashboard login OK; authenticated /v1/models OK (${catalog.data.length} models)`)
} finally {
  const removed = await fetch(`${endpoint}/api/keys/${key.id}`, { method: 'DELETE', headers: { cookie } })
  assert.equal(removed.status, 200, `Smoke API key cleanup: HTTP ${removed.status}`)
}
