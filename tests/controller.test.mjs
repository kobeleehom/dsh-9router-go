import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RouterController, resolveOptions } from '../src/controller.mjs'

function processProvider() {
  const calls = []
  return {
    calls,
    spawn(spec) {
      let settle
      const done = new Promise(resolve => { settle = resolve })
      const handle = {
        done, terminate: async () => { settle({ exitCode: 0, signal: null }) },
        waitForExit: async () => { await done },
      }
      calls.push({ spec, handle })
      return handle
    },
  }
}

test('rejects unsafe configuration before filesystem and process operations', () => {
  assert.throws(() => resolveOptions({ port: 80 }, tmpdir()), /port/)
  assert.throws(() => resolveOptions({ autoUpdate: 'true' }, tmpdir()), /autoUpdate/)
  assert.throws(() => resolveOptions({ rootDir: 'relative' }, tmpdir()), /absolute/)
  assert.throws(() => resolveOptions({ executable: process.execPath, autoUpdate: true }, tmpdir()), /cannot use automatic/)
})

test('launches localhost-only with a private password and releases ownership after close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-go-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const subprocess = processProvider()
  let probes = 0
  const fetcher = async () => {
    if (++probes === 1) throw Error('connection refused')
    return new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json' } })
  }
  const options = resolveOptions({ rootDir: root, executable: process.execPath, port: 20131 }, root)
  const controller = new RouterController(options, subprocess, { fetcher })
  await controller.initialize()
  t.after(() => controller.close())
  assert.equal(controller.endpoint, 'http://127.0.0.1:20131')
  assert.equal(controller.version, 'external')
  assert.deepEqual(subprocess.calls[0].spec.argv, [process.execPath])
  assert.equal(subprocess.calls[0].spec.env.HOST, '127.0.0.1')
  assert.equal(subprocess.calls[0].spec.env.AUTO_UPDATE, 'false')
  assert.ok(subprocess.calls[0].spec.env.INITIAL_PASSWORD.length >= 20)
  assert.equal((await readFile(join(root, 'initial-password'), 'utf8')).trim(), subprocess.calls[0].spec.env.INITIAL_PASSWORD)
  assert.equal((await stat(join(root, '.dsh-owner'))).isDirectory(), true)
  await assert.rejects(controller.checkUpdate(), /Externally managed/)
  await controller.close()
  await assert.rejects(stat(join(root, '.dsh-owner')), { code: 'ENOENT' })
  assert.throws(() => subprocess.calls[0].spec.signal.throwIfAborted(), /AbortError/)
})

test('retains the data lease when process quiescence is unknown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-go-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const provider = processProvider()
  const spawn = provider.spawn.bind(provider)
  provider.spawn = spec => {
    const handle = spawn(spec)
    handle.waitForExit = async () => { throw Error('cannot establish quiescence') }
    return handle
  }
  let first = true
  const fetcher = async () => {
    if (first) { first = false; throw Error('connection refused') }
    return new Response('{"status":"ok"}')
  }
  const controller = new RouterController(resolveOptions({ rootDir: root, executable: process.execPath }, root), provider, { fetcher })
  await controller.initialize()
  await assert.rejects(controller.close(), /did not stop cleanly/)
  assert.equal((await stat(join(root, '.dsh-owner'))).isDirectory(), true)
})

test('refuses an already owned directory and never starts another process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-go-'))
  let first
  t.after(async () => { await first?.close(); await rm(root, { recursive: true, force: true }) })
  const provider = processProvider()
  let probes = 0
  const fetcher = async () => {
    if (++probes % 2 === 1) throw Error('connection refused')
    return new Response('{"status":"ok"}')
  }
  const options = resolveOptions({ rootDir: root, executable: process.execPath }, root)
  first = new RouterController(options, provider, { fetcher })
  await first.initialize()
  const second = new RouterController(options, provider, { fetcher })
  await assert.rejects(second.initialize(), /owned by live process \d+/)
  assert.equal(provider.calls.length, 1)
})

/**
 * A host killed rather than closed leaves the lease behind. Refusing forever
 * made the plugin unrecoverable without manual cleanup, so a lease whose
 * recorded owner is gone is reclaimed instead.
 */
test('reclaims a lease whose owning process no longer exists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-go-'))
  const lock = join(root, '.dsh-owner')
  await mkdir(lock, { recursive: true })
  // A pid this high is not in use, so the recorded owner reads as dead.
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483646 }))
  const provider = processProvider()
  let probes = 0
  const fetcher = async () => {
    if (++probes % 2 === 1) throw Error('connection refused')
    return new Response('{"status":"ok"}')
  }
  const controller = new RouterController(
    resolveOptions({ rootDir: root, executable: process.execPath }, root), provider, { fetcher },
  )
  // One hook, so the process is closed before its directory is removed.
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }) })
  await controller.initialize()
  assert.equal(provider.calls.length, 1, 'the gateway starts once the stale lease is reclaimed')
})

/**
 * A lease written before ownership records existed carries no pid, so the only
 * evidence of a live owner is a gateway actually answering on the port.
 */
test('keeps a pid-less lease while a gateway answers on the port', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-go-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  await mkdir(join(root, '.dsh-owner'), { recursive: true })
  const provider = processProvider()
  const fetcher = async () => new Response('{"status":"ok"}')
  const controller = new RouterController(
    resolveOptions({ rootDir: root, executable: process.execPath }, root), provider, { fetcher },
  )
  await assert.rejects(controller.initialize(), /already serving/)
  assert.equal(provider.calls.length, 0, 'no second gateway is started')
})
