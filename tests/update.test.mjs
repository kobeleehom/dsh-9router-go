import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RouterController, resolveOptions } from '../src/controller.mjs'
import { assetName } from '../src/release.mjs'

const name = assetName()
const bytes = Buffer.alloc(2048)
if (platform() === 'win32') bytes.write('MZ')
else if (platform() === 'linux') bytes.set([0x7f, 0x45, 0x4c, 0x46])
else bytes.set([0xcf, 0xfa, 0xed, 0xfe])
const digest = createHash('sha256').update(bytes).digest('hex')

function provider() {
  const calls = []
  return { calls, spawn(spec) {
    let finish
    const done = new Promise(resolve => { finish = resolve })
    const handle = { alive: true, done, terminate: async () => { handle.alive = false; finish({ exitCode: 0, signal: null }) }, waitForExit: () => done }
    calls.push({ spec, handle })
    return handle
  } }
}

async function fixture(t, { failUpgrade = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-update-'))
  let manager
  t.after(async () => { await manager?.close(); await rm(root, { force: true, recursive: true }) })
  const old = join(root, 'runtime', '1.9.5')
  await mkdir(old, { recursive: true })
  await writeFile(join(old, name), bytes)
  await writeFile(join(root, 'current.json'), '{"version":"1.9.5"}')
  await mkdir(join(root, 'data'))
  await writeFile(join(root, 'data', 'sample.sqlite'), 'before-upgrade')
  const processes = provider()
  let downloads = 0
  let migrated = false
  const fetcher = async (url) => {
    if (url.includes('/health')) {
      if (!processes.calls.at(-1)?.handle.alive) throw Error('not listening')
      const failed = failUpgrade && processes.calls.length === 2
      if (failed && !migrated) {
        migrated = true
        await writeFile(join(root, 'data', 'sample.sqlite'), 'incompatible-migration')
      }
      return new Response(JSON.stringify({ status: failed ? 'unhealthy' : 'ok' }))
    }
    if (url.endsWith('/releases/latest')) {
      return new Response(JSON.stringify({ tag_name: 'v1.9.6', assets: [{
        name, size: bytes.length, digest: `sha256:${digest}`,
        browser_download_url: `https://github.com/luqman-v1/9router-go/releases/download/v1.9.6/${name}`,
      }] }))
    }
    ++downloads
    return new Response(bytes)
  }
  const options = resolveOptions({ rootDir: root, port: 20132, startupTimeoutMs: 1000, autoInstall: false }, root)
  manager = new RouterController(options, processes, { fetcher })
  await manager.initialize()
  return { root, manager, processes, get downloads() { return downloads } }
}

test('concurrent upgrade requests publish one verified release after readiness', async (t) => {
  const { root, manager, processes, downloads } = await fixture(t)
  assert.equal((await manager.checkUpdate()).available, true)
  const results = await Promise.all([manager.update(), manager.update()])
  assert.equal(results[0].updated, true)
  assert.equal(results[1].updated, false)
  assert.equal(processes.calls.length, 2)
  assert.equal(manager.version, '1.9.6')
  assert.equal(manager.running, true)
  assert.equal(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')).version, '1.9.6')
  assert.deepEqual(await readFile(join(root, 'runtime', '1.9.6', name)), bytes)
  const backups = await readdir(join(root, 'backups'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(root, 'backups', backups[0], 'sample.sqlite'), 'utf8'), 'before-upgrade')
})

test('failed upgrade starts prior binary and preserves the active pointer', async (t) => {
  const { root, manager, processes } = await fixture(t, { failUpgrade: true })
  await assert.rejects(manager.update(), /startup deadline/)
  assert.equal(processes.calls.length, 3)
  assert.equal(manager.version, '1.9.5')
  assert.equal(manager.running, true)
  assert.equal(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')).version, '1.9.5')
  assert.equal(await readFile(join(root, 'data', 'sample.sqlite'), 'utf8'), 'before-upgrade')
  const discarded = (await readdir(root)).find(name => name.startsWith('failed-upgrade-'))
  assert.ok(discarded)
  assert.equal(await readFile(join(root, discarded, 'sample.sqlite'), 'utf8'), 'incompatible-migration')
})
