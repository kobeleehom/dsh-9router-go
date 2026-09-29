/**
 * Fetch the pinned `zcode2api` proxy binary.
 *
 * The version is pinned rather than resolved from `latest`: the proxy drives a
 * reverse-engineered client flow, so a silent upstream change is the failure
 * mode most worth avoiding, and a fixed version keeps a working install working.
 *
 * GitHub only computes an asset's SHA-256 digest when the release is published,
 * and that digest is published through the API. Verification therefore uses the
 * API-reported digest, matching how this plugin already treats the 9router-go
 * releases; an asset without one is refused rather than trusted.
 * @module dsh-9router-go/zcode-release
 */

import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Release the plugin installs; bumping this is a deliberate, reviewed change. */
export const ZCODE_PROXY_VERSION = '1.0.1'

const REPO = 'D3-vin/Zcode2Api'
const API = `https://api.github.com/repos/${REPO}/releases/tags/v${ZCODE_PROXY_VERSION}`
const MAX_ASSET_BYTES = 60 * 1024 * 1024

/** Name of the release asset for a platform, or a throw for an unsupported one. */
export function proxyAssetName(os = platform(), cpu = arch()) {
  if (os === 'win32' && cpu === 'x64') return 'zcode2api-windows-amd64.exe'
  if (os === 'linux' && cpu === 'x64') return 'zcode2api-linux-amd64'
  if (os === 'darwin') return `zcode2api-macos-${cpu === 'x64' ? 'amd64' : 'arm64'}`
  throw new Error(`zcode2api has no release binary for ${os}/${cpu}`)
}

/** Local file name the proxy is expected under, mirroring the release naming. */
export function proxyBinaryPath(rootDir, os = platform()) {
  return join(rootDir, os === 'win32' ? 'zcode2api.exe' : 'zcode2api')
}

function verifiedAsset(release, name) {
  const asset = release?.assets?.find(item => item.name === name)
  if (asset === undefined || typeof asset.browser_download_url !== 'string'
    || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) {
    throw new Error(`zcode2api v${ZCODE_PROXY_VERSION} is missing ${name} or its GitHub SHA-256 digest`)
  }
  const url = new URL(asset.browser_download_url)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com'
    || !url.pathname.startsWith(`/${REPO}/releases/download/`)) {
    throw new Error('zcode2api release asset URL does not belong to the expected repository')
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 1024 || asset.size > MAX_ASSET_BYTES) {
    throw new Error('zcode2api release asset size is invalid')
  }
  return { name, url: url.href, sha256: asset.digest.slice(7).toLowerCase(), size: asset.size }
}

/**
 * Read the pinned release's asset metadata.
 * @param options - fetcher and target platform overrides.
 * @returns the version, asset url, size and digest.
 * @throws when the release is missing or carries no verifiable asset.
 */
export async function proxyRelease({ fetcher = fetch, os, cpu } = {}) {
  const response = await fetcher(API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-9router-go' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`zcode2api release lookup failed: HTTP ${response.status}`)
  const release = await response.json()
  return { version: ZCODE_PROXY_VERSION, asset: verifiedAsset(release, proxyAssetName(os, cpu)) }
}

function nativeHeader(bytes, os) {
  if (os === 'win32') return bytes[0] === 0x4d && bytes[1] === 0x5a
  if (os === 'linux') return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  return ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(bytes.subarray(0, 4).toString('hex'))
}

async function digestOf(path) {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Download and verify the pinned proxy binary, reusing an intact copy.
 *
 * An existing file is only accepted when its size and digest match the release,
 * so a partial download from an interrupted run is replaced rather than run.
 * The download lands in a staging directory and is published by rename, which
 * keeps a failure from leaving an unverified file where the launch path looks.
 * @param options - root directory, fetcher, and platform overrides.
 * @returns the absolute path to the verified binary.
 * @throws when the download fails verification.
 */
export async function installProxy(rootDir, { fetcher = fetch, os = platform(), cpu = arch() } = {}) {
  const release = await proxyRelease({ fetcher, os, cpu })
  const target = proxyBinaryPath(rootDir, os)
  try {
    const existing = await stat(target)
    if (existing.isFile() && existing.size === release.asset.size
      && await digestOf(target) === release.asset.sha256) {
      return target
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  const staging = join(rootDir, `.stage-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  const staged = join(staging, release.asset.name)
  try {
    const response = await fetcher(release.asset.url, { signal: AbortSignal.timeout(180000) })
    if (!response.ok || !response.body) throw new Error(`zcode2api download failed: HTTP ${response.status}`)
    const hash = createHash('sha256')
    let bytes = 0
    let header = Buffer.alloc(0)
    const measure = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > MAX_ASSET_BYTES || bytes > release.asset.size) {
          callback(new Error('Downloaded zcode2api asset exceeds its declared size'))
          return
        }
        if (header.length < 4) header = Buffer.concat([header, chunk]).subarray(0, 4)
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(staged, { flags: 'wx', mode: 0o700 }))
    if (bytes !== release.asset.size || hash.digest('hex') !== release.asset.sha256) {
      throw new Error('Downloaded zcode2api asset failed SHA-256/size verification')
    }
    if (!nativeHeader(header, os)) throw new Error('Downloaded zcode2api asset is not a native executable')
    await chmod(staged, 0o700)
    await rename(staged, target)
    return target
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Install the Node packages the proxy's captcha solver imports.
 *
 * The binary embeds `solver.js` but not its dependencies, so a machine without
 * them starts and then fails every request at mint time. The install is skipped
 * when the packages are already present, and it is the only step that needs the
 * network besides the binary download.
 * @param options - solver directory, npm runner, and deadline.
 * @returns whether packages were installed by this call.
 * @throws when npm exits non-zero, so the failure is reported before a request
 *   fails for the more confusing reason.
 */
export async function installSolverDependencies({
  solverDir, nodePath, npmCliPath, exists, runNpm, timeoutMs = 300000, log = console,
}) {
  const marker = join(solverDir, 'node_modules', 'happy-dom', 'package.json')
  if (await exists(marker)) return { installed: false }
  if (await exists(join(solverDir, 'node_modules'))) {
    // A partial tree from an interrupted install: remove it so npm cannot
    // report success against an incomplete set of packages.
    await rm(join(solverDir, 'node_modules'), { recursive: true, force: true })
  }
  const packageJson = join(solverDir, 'package.json')
  if (!await exists(packageJson)) {
    throw new Error(`zcode proxy solver directory ${solverDir} has no package.json; the binary may not have unpacked it yet`)
  }
  log.info?.('zcode: installing captcha solver dependencies (one time)')
  const code = await runNpm({
    nodePath,
    npmCliPath,
    args: ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    cwd: solverDir,
    timeoutMs,
  })
  if (code !== 0) {
    throw new Error(
      `zcode: npm install for the captcha solver exited with code ${code}. `
      + 'The proxy needs Node.js on PATH and network access to the npm registry.',
    )
  }
  if (!await exists(marker)) {
    throw new Error('zcode: npm reported success but the solver dependencies are still missing')
  }
  return { installed: true }
}

/** Read the solver directory the proxy unpacks next to its data. */
export async function solverDirectory(rootDir) {
  return join(rootDir, 'data', 'captcha_node')
}

/** Whether a file exists, used to keep the install steps idempotent. */
export async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** Read a small JSON file, answering undefined when it is absent. */
export async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
