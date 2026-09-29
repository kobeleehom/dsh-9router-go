import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assetName, currentVersion, installRelease, installedBinary, latestRelease } from './release.mjs'

/** Validate deployment-specific values before starting any external code. */
export function resolveOptions(config = {}, profileHome) {
  const port = config.port ?? 20130
  const startupTimeoutMs = config.startupTimeoutMs ?? 30000
  const shutdownGraceMs = config.shutdownGraceMs ?? 5000
  const checkIntervalHours = config.checkIntervalHours ?? 6
  const rootDir = config.rootDir ?? join(profileHome ?? homedir(), '9router-go')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('9router-go port must be 1024..65535')
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 120000) throw new Error('Invalid startupTimeoutMs')
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 100 || shutdownGraceMs > 30000) throw new Error('Invalid shutdownGraceMs')
  if (!Number.isInteger(checkIntervalHours) || checkIntervalHours < 1 || checkIntervalHours > 720) throw new Error('Invalid checkIntervalHours')
  if (!isAbsolute(rootDir)) throw new Error('9router-go rootDir must be absolute')
  for (const name of ['autoInstall', 'autoUpdate']) {
    if (config[name] !== undefined && typeof config[name] !== 'boolean') throw new Error(`${name} must be boolean`)
  }
  if (config.executable !== undefined && (!isAbsolute(config.executable) || config.autoUpdate)) {
    throw new Error('External executable must be absolute and cannot use automatic updates')
  }
  assetName() // Fail at load on unsupported CPU/OS rather than after download.
  return {
    port, startupTimeoutMs, shutdownGraceMs, checkIntervalHours,
    rootDir: resolve(rootDir), executable: config.executable,
    autoInstall: config.autoInstall ?? false, autoUpdate: config.autoUpdate ?? false,
    provider: resolveProviderOptions(config.provider),
  }
}

/** Deployment-varying model-route choices; every one is validated before use. */
function resolveProviderOptions(input = {}) {
  const provider = {
    autoInject: input.autoInject ?? false,
    settingsNamespace: input.settingsNamespace ?? 'llm-pi-ai',
    routeName: input.routeName ?? '9router-go',
    apiKeyEnv: input.apiKeyEnv ?? 'NINEROUTER_GO_API_KEY',
    keyName: input.keyName ?? 'dsh-9router-go',
    maxModels: input.maxModels ?? 40,
    inputModalities: input.inputModalities ?? ['text'],
  }
  if (typeof provider.autoInject !== 'boolean') throw new Error('provider.autoInject must be boolean')
  for (const field of ['settingsNamespace', 'routeName', 'keyName']) {
    if (typeof provider[field] !== 'string' || !/^[A-Za-z0-9._-]+$/.test(provider[field])) {
      throw new Error(`provider.${field} must be a non-empty identifier`)
    }
  }
  if (typeof provider.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv)) {
    throw new Error('provider.apiKeyEnv must be an upper-case credential reference')
  }
  if (!Number.isInteger(provider.maxModels) || provider.maxModels < 1 || provider.maxModels > 500) {
    throw new Error('provider.maxModels must be 1..500')
  }
  if (!Array.isArray(provider.inputModalities) || provider.inputModalities.length === 0
    || provider.inputModalities.some(value => value !== 'text' && value !== 'image')) {
    throw new Error("provider.inputModalities accepts only 'text' and 'image'")
  }
  return provider
}

function newerVersion(latest, installed) {
  if (!installed) return true
  const numbers = value => value.split(/[.-]/).slice(0, 3).map(Number)
  const left = numbers(latest)
  const right = numbers(installed)
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

async function initialPassword(root) {
  const path = join(root, 'initial-password')
  try {
    await writeFile(path, randomBytes(24).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const password = (await readFile(path, 'utf8')).trim()
  if (password.length < 20) throw new Error('Stored initial dashboard password is too short')
  return password
}

async function restoreBackup(root, snapshot) {
  const staged = join(root, `.restore-${randomUUID()}`)
  const quarantine = join(root, `failed-upgrade-${randomUUID()}`)
  await cp(snapshot, staged, { recursive: true })
  try {
    await rename(join(root, 'data'), quarantine)
    try {
      await rename(staged, join(root, 'data'))
    } catch (error) {
      await rename(quarantine, join(root, 'data'))
      throw error
    }
  } finally {
    await rm(staged, { recursive: true, force: true })
  }
  return quarantine
}

async function saveVersion(root, version) {
  const temp = join(root, `.current-${randomUUID()}.json`)
  try {
    await writeFile(temp, JSON.stringify({ version }) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temp, join(root, 'current.json'))
  } finally {
    await rm(temp, { force: true })
  }
}

/** The Host owns one data directory, one managed process and its update transaction. */
export class RouterController {
  #handle
  #lock
  #closed = false
  #operation = Promise.resolve()
  #timer
  #abort = new AbortController()
  #version = null
  #running = false
  #quiescenceUnknown = false

  constructor(options, subprocess, { fetcher = fetch, log = console } = {}) {
    this.options = options
    this.subprocess = subprocess
    this.fetcher = fetcher
    this.log = log
  }

  get endpoint() { return `http://127.0.0.1:${this.options.port}` }
  get dataDir() { return join(this.options.rootDir, 'data') }
  get version() { return this.#version }
  get running() { return this.#running }

  #exclusive(task) {
    const result = this.#operation.then(() => {
      if (this.#closed || this.#quiescenceUnknown) throw new Error('9router-go plugin is stopping or its prior process has not exited')
      return task()
    })
    this.#operation = result.catch(() => {})
    return result
  }

  async initialize() {
    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 })
    const lock = join(this.options.rootDir, '.dsh-owner')
    try {
      await mkdir(lock)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      throw new Error(`9router-go data directory is owned by another process (or stale lock): ${lock}`)
    }
    this.#lock = lock
    try {
      await this.#exclusive(async () => {
        let executable = this.options.executable
        let version = 'external'
        if (!executable) {
          let selected = await currentVersion(this.options.rootDir)
          if (!selected) {
            if (!this.options.autoInstall) throw new Error('No 9router-go runtime installed; enable autoInstall or configure executable')
            const release = await latestRelease({ fetcher: this.fetcher })
            selected = release.version
            executable = await installRelease(this.options.rootDir, release, { fetcher: this.fetcher })
          } else executable = await installedBinary(this.options.rootDir, selected)
          version = selected
        }
        await this.#launch(executable)
        this.#version = version
        if (version !== 'external') await saveVersion(this.options.rootDir, version)
      })
      if (this.options.autoUpdate) {
        this.#timer = setInterval(() => {
          void this.update().catch(error => this.log.warn(`9router-go update failed: ${error.message}`))
        }, this.options.checkIntervalHours * 3600000)
        this.#timer.unref?.()
      }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async #launch(executable) {
    // An existing listener must never be adopted as our process, even when its /health agrees.
    try {
      const response = await this.fetcher(`${this.endpoint}/health`, { signal: AbortSignal.timeout(500) })
      if (response) throw new Error(`9router-go port ${this.options.port} is already in use`)
    } catch (error) {
      if (error.message.includes('already in use')) throw error
    }
    const env = {
      HOST: '127.0.0.1', PORT: String(this.options.port),
      DATA_DIR: join(this.options.rootDir, 'data'), AUTO_UPDATE: 'false',
      INITIAL_PASSWORD: await initialPassword(this.options.rootDir),
    }
    const handle = this.subprocess.spawn({
      argv: [executable], cwd: this.options.rootDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 16384 } },
      graceMs: this.options.shutdownGraceMs, env, signal: this.#abort.signal,
    })
    this.#handle = handle
    handle.done.then(
      outcome => {
        if (this.#handle !== handle) return
        this.#running = false
        if (!this.#closed) this.log.warn(`9router-go exited: ${outcome.exitCode ?? outcome.signal}`)
      },
      error => {
        if (this.#handle !== handle) return
        this.#running = false
        if (!this.#closed) this.log.warn(`9router-go failed: ${error.message}`)
      },
    )
    const exit = handle.done.then(
      result => { throw new Error(`9router-go exited before readiness: ${result.exitCode ?? result.signal}`) },
      error => { throw error },
    )
    // A later ordinary exit is not a startup rejection after readiness succeeds.
    void exit.catch(() => {})
    try {
      const deadline = Date.now() + this.options.startupTimeoutMs
      while (Date.now() < deadline) {
        const probe = this.fetcher(`${this.endpoint}/health`, { signal: AbortSignal.timeout(1000) })
          .then(response => response.ok ? response.json() : null)
          .then(value => value?.status === 'ok', () => false)
        if (await Promise.race([probe, exit])) {
          this.#running = true
          return
        }
        await Promise.race([delay(150, undefined, { signal: this.#abort.signal }), exit])
      }
      throw new Error('9router-go did not pass /health before the startup deadline')
    } catch (error) {
      await this.#stop()
      throw error
    }
  }

  async #stop() {
    const handle = this.#handle
    this.#handle = undefined
    this.#running = false
    if (!handle) return
    const errors = []
    try { await handle.terminate() } catch (error) { errors.push(error) }
    try { await handle.waitForExit() } catch (error) { errors.push(error) }
    await handle.done.catch(() => {})
    if (errors.length) {
      this.#handle = handle
      this.#quiescenceUnknown = true
      throw new AggregateError(errors, '9router-go managed range did not stop cleanly')
    }
    this.#quiescenceUnknown = false
  }

  /** Check upstream metadata only; no runtime replacement or data modification. */
  async checkUpdate() {
    if (this.options.executable) throw new Error('Externally managed executable is not updated by DSH')
    const release = await latestRelease({ fetcher: this.fetcher })
    return { current: this.#version, latest: release.version, available: newerVersion(release.version, this.#version) }
  }

  /** Install, verify and restart on a newer upstream release; revert the binary pointer on failed readiness. */
  async update() {
    return this.#exclusive(async () => {
      if (this.options.executable) throw new Error('Externally managed executable is not updated by DSH')
      const release = await latestRelease({ fetcher: this.fetcher })
      if (!newerVersion(release.version, this.#version)) return { updated: false, version: this.#version }
      const binary = await installRelease(this.options.rootDir, release, { fetcher: this.fetcher })
      const previous = this.#version
      await this.#stop()
      let snapshot
      let upgradeStarted = false
      try {
        const backups = join(this.options.rootDir, 'backups')
        await mkdir(backups, { recursive: true, mode: 0o700 })
        snapshot = join(backups, `${previous}-${Date.now()}-${randomUUID()}`)
        await cp(join(this.options.rootDir, 'data'), snapshot, { recursive: true })
        upgradeStarted = true
        await this.#launch(binary)
        await saveVersion(this.options.rootDir, release.version)
        this.#version = release.version
        return { updated: true, version: release.version }
      } catch (error) {
        try {
          if (upgradeStarted) {
            await this.#stop()
            const quarantine = await restoreBackup(this.options.rootDir, snapshot)
            this.log.warn(`9router-go failed upgrade data retained at ${quarantine}`)
          }
          if (previous && previous !== 'external') {
            await this.#launch(await installedBinary(this.options.rootDir, previous))
          }
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], '9router-go upgrade and rollback both failed')
        }
        throw error
      }
    })
  }

  /** Stop the managed process and release the exclusive data-directory lease. */
  async close() {
    this.#closed = true
    this.#abort.abort()
    if (this.#timer) clearInterval(this.#timer)
    await this.#operation
    await this.#stop()
    if (this.#lock) {
      await rm(this.#lock, { recursive: true })
      this.#lock = undefined
    }
  }
}
