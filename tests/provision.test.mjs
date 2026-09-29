import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { connectedModelIds, deriveCliToken, ensureApiKey, provisionModelRoute } from '../src/provision.mjs'

const key = 'sk-' + 'a'.repeat(32)

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status })
}

test('derives the gateway CLI token from its own machine facts', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-9router-token-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await writeFile(join(dataDir, 'machine-id'), 'a'.repeat(32) + '\n')
  await mkdir(join(dataDir, 'auth'), { recursive: true })
  await writeFile(join(dataDir, 'auth', 'cli-secret'), ' ' + 'b'.repeat(64) + ' \n')
  const expected = createHash('sha256').update('a'.repeat(32) + '9r-cli-auth' + 'b'.repeat(64)).digest('hex').slice(0, 16)
  assert.equal(await deriveCliToken(dataDir), expected)
})

test('generates the lazily-created token inputs on a fresh data directory', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-9router-token-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const first = await deriveCliToken(dataDir)
  assert.match(first, /^[0-9a-f]{16}$/)
  assert.match((await readFile(join(dataDir, 'machine-id'), 'utf8')).trim(), /^[0-9a-f]{32}$/)
  assert.match((await readFile(join(dataDir, 'auth', 'cli-secret'), 'utf8')).trim(), /^[0-9a-f]{64}$/)
  assert.equal(await deriveCliToken(dataDir), first)
})

test('refuses token inputs that are not the hex upstream would write', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-9router-token-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await writeFile(join(dataDir, 'machine-id'), 'not-hex\n')
  await assert.rejects(deriveCliToken(dataDir), /not the expected 32-character lowercase hex value/)
})

test('reuses its own gateway key and creates one otherwise', async () => {
  const seen = []
  const fetcher = async (url, init = {}) => {
    seen.push({ url, init })
    if (init.method === 'POST') return json({ status: 'ok', id: 'k2', key })
    return json([{ id: 'k1', name: 'other', key: 'sk-' + 'b'.repeat(32) }, { id: 'k2', name: 'dsh-9router-go', key }])
  }
  const reused = await ensureApiKey({ endpoint: 'http://127.0.0.1:1', token: 't', keyName: 'dsh-9router-go', fetcher })
  assert.equal(reused, key)
  assert.equal(seen.length, 1)
  seen.length = 0
  const created = await ensureApiKey({ endpoint: 'http://127.0.0.1:1', token: 't', keyName: 'dsh-9router-go', fetcher: async (url, init = {}) => {
    seen.push({ url, init })
    if (init.method === 'POST') return json({ key })
    return json([{ id: 'k1', name: 'other', key: 'sk-' + 'b'.repeat(32) }])
  } })
  assert.equal(created, key)
  assert.equal(seen[1].init.method, 'POST')
  assert.equal(seen[1].init.headers['x-9r-cli-token'], 't')
  assert.equal(JSON.parse(seen[1].init.body).name, 'dsh-9router-go')
})

test('rejects key and catalog responses the gateway could not have meant', async () => {
  await assert.rejects(
    ensureApiKey({ endpoint: 'http://127.0.0.1:1', token: 't', keyName: 'k', fetcher: async () => json({}, 401) }),
    /listing gateway API keys failed: HTTP 401/,
  )
  await assert.rejects(
    ensureApiKey({ endpoint: 'http://127.0.0.1:1', token: 't', keyName: 'k', fetcher: async (url, init = {}) => (init.method === 'POST' ? json({ key: 'nope' }) : json([])) }),
    /no usable key/,
  )
})

test('reads distinct connected models and caps them', async () => {
  let requested
  const ids = await connectedModelIds({ endpoint: 'http://127.0.0.1:1', key, maxModels: 2, fetcher: async (url) => {
    requested = url
    return json({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, {}] })
  } })
  assert.deepEqual(ids, ['a', 'b'])
  assert.equal(requested, 'http://127.0.0.1:1/v1/models?connected=1')
  await assert.rejects(
    connectedModelIds({ endpoint: 'http://127.0.0.1:1', key, maxModels: 5, fetcher: async () => json({ data: [] }) }),
    /no connected model/,
  )
})

function services({ served = [] } = {}) {
  const credentials = new Map()
  const writes = []
  return {
    credentials: { set: async (ref, value) => { credentials.set(ref, value) } },
    settings: { update: async (ns, patch) => { writes.push({ ns, patch }) } },
    llm: { listProviders: () => served.map(id => ({ id, name: id })) },
    credentialsStore: credentials,
    writes,
  }
}

const provider = {
  autoInject: true,
  settingsNamespace: 'llm-pi-ai',
  routeName: '9router-go',
  apiKeyEnv: 'NINEROUTER_GO_API_KEY',
  keyName: 'dsh-9router-go',
  maxModels: 3,
  inputModalities: ['text'],
}

async function gatewayFiles(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-9router-provision-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  return dataDir
}

test('registers the route, credential, and connected models additively', async (t) => {
  const dataDir = await gatewayFiles(t)
  const h = services()
  const fetcher = async (url, init = {}) => {
    if (url.endsWith('/api/keys') && init.method === 'POST') return json({ key })
    if (url.endsWith('/api/keys')) return json([])
    return json({ data: [{ id: 'kr/claude-sonnet-4.5' }, { id: 'oc/free' }] })
  }
  const result = await provisionModelRoute({
    ...h, endpoint: 'http://127.0.0.1:20130', dataDir, provider, fetcher, log: { info() {} },
  })
  assert.deepEqual(result, { injected: true, models: ['kr/claude-sonnet-4.5', 'oc/free'] })
  assert.equal(h.credentialsStore.get('NINEROUTER_GO_API_KEY'), key)
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].ns, 'llm-pi-ai')
  assert.deepEqual(h.writes[0].patch, {
    providers: {
      '9router-go': {
        displayName: '9Router',
        apiKeyEnv: 'NINEROUTER_GO_API_KEY',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:20130/v1',
        models: [{ id: 'kr/claude-sonnet-4.5', input: ['text'] }, { id: 'oc/free', input: ['text'] }],
      },
    },
  })
})

test('never rewrites configuration once an adapter serves the route', async (t) => {
  const dataDir = await gatewayFiles(t)
  const h = services({ served: ['9router-go'] })
  const result = await provisionModelRoute({
    ...h, endpoint: 'http://127.0.0.1:20130', dataDir, provider,
    fetcher: async () => { throw new Error('must not reach the gateway') }, log: { info() {} },
  })
  assert.deepEqual(result, { injected: false, reason: 'route-already-registered' })
  assert.equal(h.writes.length, 0)
  assert.equal(h.credentialsStore.size, 0)
})
