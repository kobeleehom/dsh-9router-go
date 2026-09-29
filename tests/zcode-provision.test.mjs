import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ensureProviderConnection, ensureProviderNode, registerZcodeProvider, zcodeModelIds,
} from '../src/zcode-provision.mjs'

/** A fetcher that records every call and answers from a scripted table. */
function scriptedFetcher(routes) {
  const calls = []
  const fetcher = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const path = new URL(url).pathname
    calls.push({ method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    const route = routes.find(entry => entry.method === method && path.startsWith(entry.path))
    if (route === undefined) throw new Error(`unscripted request: ${method} ${path}`)
    return {
      ok: route.status === undefined || route.status < 400,
      status: route.status ?? 200,
      json: async () => route.body,
    }
  }
  return { fetcher, calls }
}

test('ensureProviderNode creates a node when the gateway has none by that name', async () => {
  const { fetcher, calls } = scriptedFetcher([
    { method: 'GET', path: '/api/provider-nodes', body: { nodes: [] } },
    { method: 'POST', path: '/api/provider-nodes', body: { node: { id: 'openai-compatible-chat-1' } } },
  ])
  const result = await ensureProviderNode({
    endpoint: 'http://127.0.0.1:20130', token: 'tok',
    name: 'zcode', prefix: 'zcode', baseUrl: 'http://127.0.0.1:3101/v1', fetcher,
  })
  assert.equal(result.created, true)
  assert.equal(result.id, 'openai-compatible-chat-1')
  const posted = calls.find(call => call.method === 'POST')
  assert.equal(posted.body.type, 'openai-compatible')
  assert.equal(posted.body.apiType, 'chat')
  assert.equal(posted.body.baseUrl, 'http://127.0.0.1:3101/v1')
})

test('ensureProviderNode repoints the existing node instead of duplicating it', async () => {
  const { fetcher, calls } = scriptedFetcher([
    { method: 'GET', path: '/api/provider-nodes', body: { nodes: [{ id: 'node-1', name: 'zcode' }] } },
    { method: 'PUT', path: '/api/provider-nodes/node-1', body: { status: 'ok' } },
  ])
  const result = await ensureProviderNode({
    endpoint: 'http://127.0.0.1:20130', token: 'tok',
    name: 'zcode', prefix: 'zcode', baseUrl: 'http://127.0.0.1:3101/v1', fetcher,
  })
  assert.equal(result.created, false)
  assert.equal(calls.some(call => call.method === 'POST'), false, 'a reload must not add a second node')
})

test('ensureProviderNode fails loudly when the gateway returns no id', async () => {
  const { fetcher } = scriptedFetcher([
    { method: 'GET', path: '/api/provider-nodes', body: { nodes: [] } },
    { method: 'POST', path: '/api/provider-nodes', body: {} },
  ])
  await assert.rejects(() => ensureProviderNode({
    endpoint: 'http://127.0.0.1:20130', token: 'tok',
    name: 'zcode', prefix: 'zcode', baseUrl: 'http://127.0.0.1:3101/v1', fetcher,
  }), /no node id/)
})

test('ensureProviderConnection sends the payload the dashboard create route expects', async () => {
  const { fetcher, calls } = scriptedFetcher([
    { method: 'GET', path: '/api/connections', body: [] },
    { method: 'POST', path: '/api/connections', body: { id: 'conn-1' } },
  ])
  const result = await ensureProviderConnection({
    endpoint: 'http://127.0.0.1:20130', token: 'tok', provider: 'node-1',
    apiKey: 'dsh-zcode-local', defaultModel: 'GLM-5.3-Flash', name: 'zcode', fetcher,
  })
  assert.equal(result.id, 'conn-1')
  const posted = calls.find(call => call.method === 'POST')
  assert.equal(posted.body.authType, 'compatible')
  assert.equal(posted.body.isActive, 1)
  assert.equal(posted.body.defaultModel, 'GLM-5.3-Flash')
})

test('ensureProviderConnection updates the connection that already serves the node', async () => {
  const { fetcher, calls } = scriptedFetcher([
    { method: 'GET', path: '/api/connections', body: [{ id: 'conn-9', provider: 'node-1' }] },
    { method: 'PUT', path: '/api/connections/conn-9', body: { id: 'conn-9' } },
  ])
  const result = await ensureProviderConnection({
    endpoint: 'http://127.0.0.1:20130', token: 'tok', provider: 'node-1',
    apiKey: 'key', defaultModel: 'GLM-5.3-Flash', name: 'zcode', fetcher,
  })
  assert.equal(result.created, false)
  assert.equal(result.id, 'conn-9')
  assert.equal(calls.some(call => call.method === 'POST'), false)
})

/**
 * The gateway's update route reads the merged `data` map and ignores a
 * top-level `apiKey`, so a payload carrying only that field reports success
 * while the previous credential stays in place — which surfaces later as an
 * upstream 401 on a connection that looks correctly configured.
 */
test('ensureProviderConnection puts the credential inside data on update', async () => {
  const { fetcher, calls } = scriptedFetcher([
    { method: 'GET', path: '/api/connections', body: [{ id: 'conn-9', provider: 'node-1' }] },
    { method: 'PUT', path: '/api/connections/conn-9', body: { id: 'conn-9' } },
  ])
  await ensureProviderConnection({
    endpoint: 'http://127.0.0.1:20130', token: 'tok', provider: 'node-1',
    apiKey: 'fresh-key', defaultModel: 'GLM-5.3-Flash', name: 'zcode', fetcher,
  })
  const put = calls.find(call => call.method === 'PUT')
  assert.equal(put.body.data.apiKey, 'fresh-key', 'the update route only honours the data map')
  assert.equal(put.body.data.defaultModel, 'GLM-5.3-Flash')
})

test('zcodeModelIds reports only the models served through the ZCode prefix', async () => {
  const { fetcher } = scriptedFetcher([
    {
      method: 'GET',
      path: '/v1/models',
      body: { data: [{ id: 'zcode/GLM-5.3-Flash' }, { id: 'mm/deepseek-flash' }, { id: 'cbcn/glm-5.3-flash' }] },
    },
  ])
  const ids = await zcodeModelIds({
    endpoint: 'http://127.0.0.1:20130', key: 'sk-1', prefix: 'zcode', maxModels: 40, fetcher,
  })
  assert.deepEqual(ids, ['zcode/GLM-5.3-Flash'])
})

test('zcodeModelIds fails when the node has not activated yet', async () => {
  const { fetcher } = scriptedFetcher([
    { method: 'GET', path: '/v1/models', body: { data: [{ id: 'mm/deepseek-flash' }] } },
  ])
  await assert.rejects(() => zcodeModelIds({
    endpoint: 'http://127.0.0.1:20130', key: 'sk-1', prefix: 'zcode', maxModels: 40, fetcher,
  }), /no model under the "zcode\/" prefix/)
})

test('registerZcodeProvider registers the node, its connection, and its models in order', async () => {
  const { fetcher, calls } = scriptedFetcher([
    { method: 'GET', path: '/api/provider-nodes', body: { nodes: [] } },
    { method: 'POST', path: '/api/provider-nodes', body: { node: { id: 'node-1' } } },
    { method: 'GET', path: '/api/connections', body: [] },
    { method: 'POST', path: '/api/connections', body: { id: 'conn-1' } },
    { method: 'POST', path: '/api/models/custom', body: { status: 'ok' } },
  ])
  const result = await registerZcodeProvider({
    endpoint: 'http://127.0.0.1:20130', token: 'tok', proxyEndpoint: 'http://127.0.0.1:3101',
    apiKey: 'dsh-zcode-local', prefix: 'zcode', models: ['GLM-5.3-Flash'],
    routeName: 'zcode', fetcher, log: { info() {} },
  })
  assert.equal(result.nodeId, 'node-1')
  assert.equal(result.connectionId, 'conn-1')
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    'GET /api/provider-nodes',
    'POST /api/provider-nodes',
    'GET /api/connections',
    'POST /api/connections',
    'POST /api/models/custom',
  ])
})

/**
 * A node whose models were never registered stays absent from `?connected=1`
 * even though its connection is active, so the custom-model write is the step
 * that makes the provider usable and must carry the gateway node id.
 */
test('registerZcodeProvider binds each model to the gateway node id', async () => {
  const { fetcher, calls } = scriptedFetcher([
    { method: 'GET', path: '/api/provider-nodes', body: { nodes: [] } },
    { method: 'POST', path: '/api/provider-nodes', body: { node: { id: 'node-7' } } },
    { method: 'GET', path: '/api/connections', body: [] },
    { method: 'POST', path: '/api/connections', body: { id: 'conn-7' } },
    { method: 'POST', path: '/api/models/custom', body: { status: 'ok' } },
  ])
  await registerZcodeProvider({
    endpoint: 'http://127.0.0.1:20130', token: 'tok', proxyEndpoint: 'http://127.0.0.1:3101',
    apiKey: 'key', prefix: 'zcode', models: ['GLM-5.3-Flash', 'GLM-5.3'],
    routeName: 'zcode', fetcher, log: { info() {} },
  })
  const registrations = calls.filter(call => call.path === '/api/models/custom')
  assert.deepEqual(registrations.map(call => call.body), [
    { id: 'GLM-5.3-Flash', providerAlias: 'node-7', type: 'llm' },
    { id: 'GLM-5.3', providerAlias: 'node-7', type: 'llm' },
  ])
})
