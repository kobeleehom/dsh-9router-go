import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const API = 'https://api.github.com/repos/luqman-v1/9router-go/releases/latest'
const MAX_ASSET_BYTES = 100 * 1024 * 1024
const VERSION = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-.][a-zA-Z0-9]+)*$/

/** Select only an upstream-supported native release artifact. */
export function assetName(os = platform(), cpu = arch()) {
  if (os === 'win32' && cpu === 'x64') return '9router-go-windows-amd64.exe'
  if (['linux', 'darwin'].includes(os) && ['x64', 'arm64'].includes(cpu)) {
    return `9router-go-${os}-${cpu === 'x64' ? 'amd64' : 'arm64'}`
  }
  throw new Error(`9router-go has no release binary for ${os}/${cpu}`)
}

function verifiedVersion(tag) {
  if (typeof tag !== 'string' || !VERSION.test(tag)) throw new Error('Release tag is not a safe semantic version')
  return tag.replace(/^v/, '')
}

function verifiedAsset(release, name) {
  const asset = release.assets?.find(item => item.name === name)
  if (!asset || typeof asset.browser_download_url !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) {
    throw new Error(`Release is missing ${name} or its GitHub SHA-256 digest`)
  }
  const url = new URL(asset.browser_download_url)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/luqman-v1/9router-go/releases/download/')) {
    throw new Error('Release asset URL does not belong to 9router-go')
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 1024 || asset.size > MAX_ASSET_BYTES) {
    throw new Error('Release asset size is invalid')
  }
  return { name, url: url.href, sha256: asset.digest.slice(7).toLowerCase(), size: asset.size }
}

/** Fetch official release metadata, refusing missing digests and unexpected origins. */
export async function latestRelease({ fetcher = fetch, os, cpu } = {}) {
  const response = await fetcher(API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-9router-go' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`)
  const release = await response.json()
  if (release.draft || release.prerelease) throw new Error('Latest release is not stable')
  return { version: verifiedVersion(release.tag_name), asset: verifiedAsset(release, assetName(os, cpu)) }
}

function hasExecutableHeader(bytes, os) {
  if (os === 'win32') return bytes[0] === 0x4d && bytes[1] === 0x5a
  if (os === 'linux') return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  const magic = bytes.subarray(0, 4).toString('hex')
  return ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic)
}

/** Stage an exact upstream binary, verify its hash and native header, then publish its version directory. */
export async function installRelease(root, release, { fetcher = fetch, os = platform() } = {}) {
  const version = verifiedVersion(release.version)
  const name = assetName(os, arch())
  if (release.asset.name !== name || !/^https:\/\/github\.com\/luqman-v1\/9router-go\/releases\/download\//.test(release.asset.url)) {
    throw new Error('Release asset is not the expected platform binary')
  }
  if (!/^[a-f0-9]{64}$/.test(release.asset.sha256)) throw new Error('Release SHA-256 is missing')
  const folder = join(root, 'runtime', version)
  const target = join(folder, name)
  try {
    const old = await stat(target)
    if (old.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(target)) hash.update(chunk)
      if (old.size !== release.asset.size || hash.digest('hex') !== release.asset.sha256) {
        throw new Error('Installed release does not match its published SHA-256')
      }
      return target
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(join(root, 'runtime'), { recursive: true, mode: 0o700 })
  const staging = join(root, 'runtime', `.stage-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  const temporary = join(staging, name)
  try {
    const response = await fetcher(release.asset.url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok || !response.body) throw new Error(`Binary download failed: HTTP ${response.status}`)
    const hash = createHash('sha256')
    let bytes = 0
    let header = Buffer.alloc(0)
    const measure = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > MAX_ASSET_BYTES || bytes > release.asset.size) {
          callback(new Error('Downloaded asset exceeds its declared size'))
          return
        }
        if (header.length < 4) header = Buffer.concat([header, chunk]).subarray(0, 4)
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(temporary, { flags: 'wx', mode: 0o700 }))
    if (bytes !== release.asset.size || hash.digest('hex') !== release.asset.sha256) throw new Error('Downloaded asset failed SHA-256/size verification')
    if (!hasExecutableHeader(header, os)) throw new Error('Downloaded asset does not have a native executable header')
    await chmod(temporary, 0o700)
    try {
      await rename(staging, folder)
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
      const existing = await stat(target)
      if (!existing.isFile()) throw error
    }
    return target
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Resolve an installed version without accepting untrusted filesystem paths. */
export async function installedBinary(root, version, os = platform(), cpu = arch()) {
  const name = assetName(os, cpu)
  const target = join(root, 'runtime', verifiedVersion(version), name)
  const file = await stat(target)
  if (!file.isFile()) throw new Error(`Installed release is not a file: ${basename(target)}`)
  return target
}

/** Read the active runtime version; an absent pointer means no version is installed. */
export async function currentVersion(root) {
  try {
    const record = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
    return verifiedVersion(record.version)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
