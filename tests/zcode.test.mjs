import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ZcodeController, readZcodeToken, resolveZcodeOptions } from '../src/zcode.mjs'

/** Write a throwaway file so credential-store cases touch real IO. */
async function fixture(name, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-test-'))
  const path = join(directory, name)
  await writeFile(path, contents, 'utf8')
  return path
}

test('resolveZcodeOptions rejects a port outside the unprivileged range', () => {
  assert.throws(() => resolveZcodeOptions({ port: 80 }, '/tmp'), /3101|1024/)
})

test('resolveZcodeOptions rejects a legacy auth token list holding an empty entry', () => {
  assert.throws(() => resolveZcodeOptions({ legacyAuthTokens: [''] }, '/tmp'), /legacyAuthTokens/)
})

test('resolveZcodeOptions requires an absolute rootDir', () => {
  assert.throws(() => resolveZcodeOptions({ rootDir: 'relative/dir' }, '/tmp'), /absolute/)
})

/**
 * The proxy persists its admin and gateway keys in SQLite and lets that stored
 * value win over `.env`, so a key the operator already changed must still be
 * usable to migrate forward. This drives a live fake proxy over HTTP.
 */
test('ZcodeController migrates a proxy whose stored key is a listed legacy value', async () => {
  const seen = []
  const server = await startFakeProxy((request, respond) => {
    seen.push({ authorization: request.headers.authorization, body: request.body })
    if (request.headers.authorization === 'Bearer old-password') {
      respond(200, { ok: true })
      return
    }
    respond(401, { error: 'invalid gateway key' })
  })
  const controller = new ZcodeController(
    resolveZcodeOptions({
      enabled: true, port: server.port, authToken: 'new-password',
      legacyAuthTokens: ['old-password'], rootDir: 'D:\\profiles\\zcode2api',
    }, '/tmp'),
    {},
    { log: silentLogger() },
  )
  await controller.syncCredentials()
  assert.equal(seen.length, 2, 'the configured key is tried before the legacy one')
  assert.equal(seen[0].authorization, 'Bearer new-password')
  assert.equal(seen[1].authorization, 'Bearer old-password')
  assert.deepEqual(seen[1].body, { admin_password: 'new-password', gateway_key: 'new-password' })
})

test('ZcodeController reports a proxy whose stored key matches nothing known', async () => {
  const server = await startFakeProxy((request, respond) => respond(401, { error: 'invalid gateway key' }))
  const controller = new ZcodeController(
    resolveZcodeOptions({
      enabled: true, port: server.port, authToken: 'new-password',
      legacyAuthTokens: ['old-password'], rootDir: 'D:\\profiles\\zcode2api',
    }, '/tmp'),
    {},
    { log: silentLogger() },
  )
  await assert.rejects(() => controller.syncCredentials(), /rejected every known password/)
})

test('ZcodeController succeeds without a legacy list when the key already matches', async () => {
  const server = await startFakeProxy((request, respond) => respond(200, { ok: true }))
  const controller = new ZcodeController(
    resolveZcodeOptions({ enabled: true, port: server.port, authToken: 'only-password' }, '/tmp'),
    {},
    { log: silentLogger() },
  )
  await controller.syncCredentials()
})

/** Minimal stand-in for the proxy's `/api/settings` route. */
async function startFakeProxy(handler) {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      handler(
        { headers: request.headers, body: raw.length === 0 ? undefined : JSON.parse(raw) },
        (status, payload) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(payload))
        },
      )
    })
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  test.after?.(() => server.close())
  return { port, close: () => server.close() }
}

test('resolveZcodeOptions rejects a captcha timeout that is not a Go duration', () => {
  assert.throws(() => resolveZcodeOptions({ captchaTimeout: 60 }, '/tmp'), /Go duration/)
})

test('resolveZcodeOptions rejects an unusable route prefix', () => {
  assert.throws(() => resolveZcodeOptions({ routePrefix: 'bad/prefix' }, '/tmp'), /identifier/)
})

test('resolveZcodeOptions defaults to disabled with the documented port and model', () => {
  const options = resolveZcodeOptions({}, '/tmp/profile')
  assert.equal(options.enabled, false)
  assert.equal(options.port, 3101)
  assert.deepEqual(options.models, ['GLM-5.3-Flash'])
  assert.equal(options.routePrefix, 'zcode')
})

test('resolveZcodeOptions keeps an absolute rootDir under the profile', () => {
  const options = resolveZcodeOptions({ rootDir: 'D:\\profiles\\zcode2api' }, '/tmp')
  assert.equal(options.rootDir, 'D:\\profiles\\zcode2api')
})

/**
 * The token file, `.env` and `data/` are all resolved by the proxy against its
 * working directory, so a launch from anywhere else silently starts with an
 * empty pool. This asserts the controller pins `cwd` to its own root.
 */
test('ZcodeController launches the proxy inside its own root directory', async () => {
  const launched = []
  const controller = new ZcodeController(
    resolveZcodeOptions({ enabled: true, rootDir: 'D:\\profiles\\zcode2api', port: 31999 }, '/tmp'),
    { spawn: (...args) => { launched.push(args); return fakeChild() } },
    { log: silentLogger() },
  )
  await assert.rejects(
    () => controller.initialize(),
    /proxy binary not found/,
    'an absent binary is reported before any spawn happens',
  )
  assert.deepEqual(launched, [])
})

test('ZcodeController.close tolerates a proxy that never started', async () => {
  const controller = new ZcodeController(
    resolveZcodeOptions({ enabled: true, rootDir: 'D:\\profiles\\zcode2api' }, '/tmp'),
    {},
    { log: silentLogger() },
  )
  await controller.close()
})

/**
 * A credential store that exists but cannot be decrypted means a real change
 * upstream; reporting it is what keeps the operator from debugging a proxy
 * that is running with no account.
 */
test('readZcodeToken reports a decryption failure instead of returning nothing', async () => {
  const store = JSON.stringify({ zcodejwttoken: 'enc:v1:aaa.bbb.ccc' })
  const credentialsPath = await fixture('credentials.json', store)
  await assert.rejects(
    () => readZcodeToken({
      credentialsPath,
      createDecipheriv: () => { throw new Error('bad key') },
      createHash: () => ({ update: () => ({ digest: () => Buffer.alloc(32) }) }),
      home: '/home/u',
      username: 'u',
    }),
    /could not decrypt/,
  )
})

test('readZcodeToken rejects a credential entry that is not in the enc:v1 form', async () => {
  const store = JSON.stringify({ zcodejwttoken: 'plain-text-token' })
  const token = await readZcodeToken({
    credentialsPath: await fixture('plain.json', store),
    createDecipheriv: () => { throw new Error('must not be called') },
    createHash: () => { throw new Error('must not be called') },
    home: '/home/u',
    username: 'u',
  })
  assert.equal(token, undefined, 'a store without an encrypted entry has no token to seed')
})

test('readZcodeToken answers undefined when the credential store is absent', async () => {
  const token = await readZcodeToken({
    credentialsPath: join(tmpdir(), `missing-${Math.random()}.json`),
    createDecipheriv: () => { throw new Error('must not be called') },
    createHash: () => { throw new Error('must not be called') },
  })
  assert.equal(token, undefined)
})

test('readZcodeToken requires crypto primitives to be supplied', async () => {
  await assert.rejects(() => readZcodeToken({ credentialsPath: 'x' }), /crypto primitives/)
})

function fakeChild() {
  return { exitCode: null, kill() {}, once() {}, stdout: undefined, stderr: undefined }
}

function silentLogger() {
  return { info() {}, warn() {}, debug() {} }
}
