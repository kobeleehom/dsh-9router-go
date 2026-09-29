import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assetName, currentVersion, installRelease, latestRelease } from '../src/release.mjs'

const artifact = Buffer.alloc(2048)
artifact.write('MZ')
const digest = createHash('sha256').update(artifact).digest('hex')
const asset = {
  name: '9router-go-windows-amd64.exe',
  url: 'https://github.com/luqman-v1/9router-go/releases/download/v1.9.5/9router-go-windows-amd64.exe',
  sha256: digest, size: artifact.length,
}
const release = { version: '1.9.5', asset }

test('selects exact supported release assets', () => {
  assert.equal(assetName('win32', 'x64'), asset.name)
  assert.equal(assetName('linux', 'arm64'), '9router-go-linux-arm64')
  assert.throws(() => assetName('win32', 'arm64'), /no release binary/)
})

test('rejects release metadata missing digest, other host and malformed tag', async () => {
  const fetcher = async () => new Response(JSON.stringify({
    tag_name: 'v1.9.5', assets: [{
      name: asset.name, browser_download_url: asset.url, size: artifact.length,
    }],
  }), { status: 200 })
  await assert.rejects(latestRelease({ fetcher, os: 'win32', cpu: 'x64' }), /digest/)
  const make = (patch) => async () => new Response(JSON.stringify({
    tag_name: 'v1.9.5', assets: [{ name: asset.name, browser_download_url: asset.url, size: artifact.length, digest: `sha256:${digest}`, ...patch }],
  }), { status: 200 })
  await assert.rejects(latestRelease({ fetcher: make({ browser_download_url: 'https://attacker.example/binary' }), os: 'win32', cpu: 'x64' }), /does not belong/)
  await assert.rejects(latestRelease({ fetcher: async () => new Response(JSON.stringify({ tag_name: '../evil' })), os: 'win32', cpu: 'x64' }), /safe semantic version/)
  assert.equal((await latestRelease({ fetcher: make({}), os: 'win32', cpu: 'x64' })).version, '1.9.5')
})

test('stages and validates a binary without touching private state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-go-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const binary = await installRelease(root, release, { os: 'win32', fetcher: async () => new Response(artifact) })
  assert.deepEqual(await readFile(binary), artifact)
  assert.equal(await currentVersion(root), null)
  assert.equal(await installRelease(root, release, { os: 'win32', fetcher: () => { throw Error('unexpected fetch') } }), binary)
  const changed = { ...release, asset: { ...asset, sha256: '0'.repeat(64) } }
  await assert.rejects(installRelease(root, changed, { os: 'win32' }), /does not match/)
})

test('refuses corrupt downloads without publishing a version directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-9router-go-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  await assert.rejects(installRelease(root, release, { os: 'win32', fetcher: async () => new Response(Buffer.alloc(2048)) }), /SHA-256/)
  await assert.rejects(readFile(join(root, 'runtime', '1.9.5', asset.name)), { code: 'ENOENT' })
  const html = Buffer.alloc(2048, 'x')
  const bad = { ...release, asset: { ...asset, sha256: createHash('sha256').update(html).digest('hex') } }
  await assert.rejects(installRelease(root, bad, { os: 'win32', fetcher: async () => new Response(html) }), /executable header/)
})
