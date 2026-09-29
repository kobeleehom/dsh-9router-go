import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  installProxy, installSolverDependencies, proxyAssetName, proxyBinaryPath, proxyRelease,
} from '../src/zcode-release.mjs'

const DIGEST = 'a'.repeat(64)
const PAYLOAD = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(2046, 7)])

/** A release body whose single asset carries a real digest for the payload. */
function releaseBody(name, { digest, size } = {}) {
  return {
    assets: [{
      name,
      browser_download_url: `https://github.com/D3-vin/Zcode2Api/releases/download/v1.0.1/${name}`,
      digest: digest === undefined ? `sha256:${createHash('sha256').update(PAYLOAD).digest('hex')}` : digest,
      size: size ?? PAYLOAD.length,
    }],
  }
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

function bytesResponse(bytes, status = 200) {
  return { ok: status < 400, status, body: new Blob([bytes]).stream() }
}

/** Route GitHub metadata and asset downloads to scripted answers. */
function releaseFetcher({ metadata, bytes = PAYLOAD, assetStatus = 200 } = {}) {
  const calls = []
  const fetcher = async (url) => {
    calls.push(url)
    if (url.includes('api.github.com')) return jsonResponse(metadata)
    return bytesResponse(bytes, assetStatus)
  }
  return { fetcher, calls }
}

async function scratch() {
  return mkdtemp(join(tmpdir(), 'zcode-release-'))
}

/** File-existence probe matching the shape `installSolverDependencies` expects. */
async function exists(path) {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('proxyAssetName maps the platforms the release publishes', () => {
  assert.equal(proxyAssetName('win32', 'x64'), 'zcode2api-windows-amd64.exe')
  assert.equal(proxyAssetName('linux', 'x64'), 'zcode2api-linux-amd64')
  assert.equal(proxyAssetName('darwin', 'arm64'), 'zcode2api-macos-arm64')
  assert.equal(proxyAssetName('darwin', 'x64'), 'zcode2api-macos-amd64')
})

test('proxyAssetName refuses a platform the release has no binary for', () => {
  assert.throws(() => proxyAssetName('linux', 'arm64'), /no release binary/)
})

test('proxyBinaryPath uses the .exe suffix only on Windows', () => {
  assert.equal(proxyBinaryPath('C:\\r', 'win32'), join('C:\\r', 'zcode2api.exe'))
  assert.equal(proxyBinaryPath('/r', 'linux'), join('/r', 'zcode2api'))
})

test('proxyRelease refuses an asset with no digest', async () => {
  const { fetcher } = releaseFetcher({
    metadata: releaseBody('zcode2api-windows-amd64.exe', { digest: null }),
  })
  await assert.rejects(() => proxyRelease({ fetcher, os: 'win32', cpu: 'x64' }), /SHA-256 digest/)
})

test('proxyRelease refuses an asset hosted outside the pinned repository', async () => {
  const body = releaseBody('zcode2api-windows-amd64.exe')
  body.assets[0].browser_download_url = 'https://evil.example.com/zcode2api.exe'
  const { fetcher } = releaseFetcher({ metadata: body })
  await assert.rejects(() => proxyRelease({ fetcher, os: 'win32', cpu: 'x64' }), /does not belong/)
})

test('installProxy downloads, verifies and publishes the binary', async () => {
  const root = await scratch()
  const { fetcher, calls } = releaseFetcher({ metadata: releaseBody('zcode2api-windows-amd64.exe') })
  const installed = await installProxy(root, { fetcher, os: 'win32', cpu: 'x64' })
  assert.equal(installed, proxyBinaryPath(root, 'win32'))
  assert.deepEqual(await readFile(installed), PAYLOAD)
  assert.equal(calls.length, 2, 'one metadata call and one asset download')
})

/**
 * An interrupted download leaves a file where the launch path looks. Accepting
 * it on size alone would run a truncated binary, so the digest decides.
 */
test('installProxy replaces a file whose digest does not match', async () => {
  const root = await scratch()
  await writeFile(proxyBinaryPath(root, 'win32'), Buffer.alloc(PAYLOAD.length, 9))
  const { fetcher } = releaseFetcher({ metadata: releaseBody('zcode2api-windows-amd64.exe') })
  const installed = await installProxy(root, { fetcher, os: 'win32', cpu: 'x64' })
  assert.deepEqual(await readFile(installed), PAYLOAD)
})

test('installProxy reuses an intact copy without downloading again', async () => {
  const root = await scratch()
  await writeFile(proxyBinaryPath(root, 'win32'), PAYLOAD)
  const { fetcher, calls } = releaseFetcher({ metadata: releaseBody('zcode2api-windows-amd64.exe') })
  await installProxy(root, { fetcher, os: 'win32', cpu: 'x64' })
  assert.equal(calls.length, 1, 'only the metadata call is made')
})

test('installProxy rejects a download whose bytes do not match the digest', async () => {
  const root = await scratch()
  const tampered = Buffer.concat([PAYLOAD, Buffer.alloc(2048, 3)])
  const { fetcher } = releaseFetcher({
    metadata: releaseBody('zcode2api-windows-amd64.exe', { size: tampered.length }),
    bytes: tampered,
  })
  await assert.rejects(
    () => installProxy(root, { fetcher, os: 'win32', cpu: 'x64' }),
    /exceeds its declared size|failed SHA-256/,
  )
})

test('installProxy rejects a payload that is not a native executable', async () => {
  const root = await scratch()
  const notExecutable = Buffer.alloc(2048, 0x41)
  const metadata = releaseBody('zcode2api-windows-amd64.exe', {
    digest: `sha256:${createHash('sha256').update(notExecutable).digest('hex')}`,
    size: notExecutable.length,
  })
  const { fetcher } = releaseFetcher({ metadata, bytes: notExecutable })
  await assert.rejects(() => installProxy(root, { fetcher, os: 'win32', cpu: 'x64' }), /native executable/)
})

test('installProxy leaves no staged directory behind on failure', async () => {
  const root = await scratch()
  const { fetcher } = releaseFetcher({ metadata: releaseBody('zcode2api-windows-amd64.exe'), assetStatus: 500 })
  await assert.rejects(() => installProxy(root, { fetcher, os: 'win32', cpu: 'x64' }), /download failed/)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(root), [], 'staging is cleaned up')
})

test('installSolverDependencies skips an install when the packages are present', async () => {
  const dir = await scratch()
  await mkdir(join(dir, 'node_modules', 'happy-dom'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'happy-dom', 'package.json'), '{}')
  let ran = false
  const result = await installSolverDependencies({
    solverDir: dir,
    exists,
    runNpm: async () => { ran = true; return 0 },
  })
  assert.equal(result.installed, false)
  assert.equal(ran, false)
})

test('installSolverDependencies installs into a directory the proxy unpacked', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'happy-dom': '^20' } }))
  let seen
  const result = await installSolverDependencies({
    solverDir: dir,
    nodePath: 'node',
    exists,
    runNpm: async options => {
      seen = options
      await mkdir(join(dir, 'node_modules', 'happy-dom'), { recursive: true })
      await writeFile(join(dir, 'node_modules', 'happy-dom', 'package.json'), '{}')
      return 0
    },
  })
  assert.equal(result.installed, true)
  assert.equal(seen.cwd, dir)
  assert.ok(seen.args.includes('install'))
})

test('installSolverDependencies reports npm exiting non-zero', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'package.json'), '{}')
  await assert.rejects(() => installSolverDependencies({
    solverDir: dir,
    exists,
    runNpm: async () => 1,
  }), /exited with code 1/)
})

test('installSolverDependencies reports a solver directory with no package.json', async () => {
  const dir = await scratch()
  await assert.rejects(() => installSolverDependencies({
    solverDir: dir,
    exists,
    runNpm: async () => 0,
  }), /no package.json/)
})

test('installSolverDependencies fails when npm claims success but packages are absent', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'package.json'), '{}')
  await assert.rejects(() => installSolverDependencies({
    solverDir: dir,
    exists,
    runNpm: async () => 0,
  }), /still missing/)
})
