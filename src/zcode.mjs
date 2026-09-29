/**
 * Managed ZCode proxy sidecar.
 *
 * The upstream `zcode2api` gateway republishes a ZCode (Z.ai) Start Plan
 * account as an OpenAI-compatible endpoint. It runs as a separate process
 * rather than being embedded, because it carries a third-party binary and a
 * Node captcha solver that this plugin drives instead of redistributing.
 *
 * Three upstream facts drive this implementation:
 *
 *  - the proxy resolves BOTH `.env` and `data/` relative to its working
 *    directory, so every launch pins `cwd` to the plugin's own root;
 *  - it installs no signal handler, so teardown is a real kill and readiness
 *    must be polled on `/api/health` rather than inferred from the process; and
 *  - it unpacks its captcha solver without its dependencies, so the packages
 *    are installed once before the first launch.
 * @module dsh-9router-go/zcode
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  fileExists, installProxy, installSolverDependencies, proxyBinaryPath, solverDirectory,
} from './zcode-release.mjs'

/** Readiness probe; the proxy answers this without authentication. */
const HEALTH_PATH = '/api/health'

/**
 * Run `npm install` in a directory and resolve to its exit code.
 *
 * The Desktop application ships its own Node and npm, and that pair is what a
 * managed install should use: a PATH npm may belong to a different Node than
 * the one the solver will run under. `npmCliPath` names that npm's entry script
 * when the caller knows it.
 * @param options - node and npm entry points, arguments, working directory, deadline.
 * @returns the npm exit code, or a non-zero code when the runner cannot start.
 */
function defaultRunNpm({ nodePath, npmCliPath, args, cwd, timeoutMs }) {
  return new Promise(resolveCode => {
    const command = npmCliPath === undefined ? 'npm' : nodePath
    const argv = npmCliPath === undefined ? args : [npmCliPath, ...args]
    let child
    try {
      child = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolveCode(127)
      return
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolveCode(127) })
    child.on('exit', code => { clearTimeout(timer); resolveCode(code ?? 1) })
  })
}

/**
 * Validate the ZCode proxy options before any external code runs.
 * @param input - the `zcode` block declared by `cordis.patch.yml`.
 * @param fallbackRoot - profile-scoped directory for downloads and data.
 * @returns validated options, with every path absolute.
 * @throws when a value is unusable, so a misconfiguration fails at load.
 */
export function resolveZcodeOptions(input = {}, fallbackRoot) {
  const enabled = input.enabled ?? false
  if (typeof enabled !== 'boolean') throw new Error('zcode.enabled must be boolean')
  const port = input.port ?? 3101
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('zcode.port must be 1024..65535')
  const startupTimeoutMs = input.startupTimeoutMs ?? 60000
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 300000) {
    throw new Error('Invalid zcode.startupTimeoutMs')
  }
  // The first request mints a captcha, which upstream documents as stalling
  // once before succeeding; the proxy's own default budget is 40s.
  const captchaTimeout = input.captchaTimeout ?? '60s'
  if (typeof captchaTimeout !== 'string' || !/^\d+s$/.test(captchaTimeout)) {
    throw new Error('zcode.captchaTimeout must be a Go duration in seconds, such as "60s"')
  }
  const authToken = input.authToken ?? 'dsh-zcode-local'
  if (typeof authToken !== 'string' || authToken.length === 0) throw new Error('zcode.authToken must be a non-empty string')
  // Passwords this proxy may already hold in its database. A stored key wins
  // over `.env`, so a changed `authToken` is only recoverable if the previous
  // value is known; listing it here lets the plugin migrate instead of locking
  // the operator out of their own proxy.
  const legacyAuthTokens = input.legacyAuthTokens ?? []
  if (!Array.isArray(legacyAuthTokens) || legacyAuthTokens.some(token => typeof token !== 'string' || token.length === 0)) {
    throw new Error('zcode.legacyAuthTokens must be a list of non-empty strings')
  }
  const rootDir = input.rootDir ?? join(fallbackRoot, 'zcode2api')
  if (!isAbsolute(rootDir)) throw new Error('zcode.rootDir must be absolute')
  if (input.executable !== undefined && !isAbsolute(input.executable)) {
    throw new Error('zcode.executable must be absolute')
  }
  if (input.nodePath !== undefined && !isAbsolute(input.nodePath)) {
    throw new Error('zcode.nodePath must be absolute')
  }
  const routePrefix = input.routePrefix ?? 'zcode'
  if (typeof routePrefix !== 'string' || !/^[A-Za-z0-9_-]+$/.test(routePrefix)) {
    throw new Error('zcode.routePrefix must be a non-empty identifier')
  }
  const routeName = input.routeName ?? 'zcode'
  if (typeof routeName !== 'string' || routeName.length === 0) {
    throw new Error('zcode.routeName must be a non-empty string')
  }
  const autoInstall = input.autoInstall ?? false
  if (typeof autoInstall !== 'boolean') throw new Error('zcode.autoInstall must be boolean')
  if (autoInstall && input.executable !== undefined) {
    throw new Error('zcode.executable and zcode.autoInstall are mutually exclusive: a managed binary is not downloaded when you supply your own')
  }
  // Models the proxy is expected to expose. Upstream syncs its catalog from the
  // account's billing entitlements, so this is a declared list rather than a
  // probe; the gateway reports what actually registered afterwards.
  const models = input.models ?? ['GLM-5.3-Flash']
  if (!Array.isArray(models) || models.length === 0
    || models.some(model => typeof model !== 'string' || model.length === 0)) {
    throw new Error('zcode.models must be a non-empty list of model ids')
  }
  // How long to wait for the bundled solver packages to appear. The proxy
  // unpacks them in about ten seconds, but a cold start on a busy or scanned
  // disk is slower, and giving up early is what turned a slow start into a
  // failed one.
  const solverReadyTimeoutMs = input.solverReadyTimeoutMs ?? 90000
  if (!Number.isInteger(solverReadyTimeoutMs) || solverReadyTimeoutMs < 1000 || solverReadyTimeoutMs > 600000) {
    throw new Error('zcode.solverReadyTimeoutMs must be 1000..600000')
  }
  return {
    enabled, port, startupTimeoutMs, captchaTimeout, authToken, legacyAuthTokens,
    routePrefix, routeName, models, autoInstall, solverReadyTimeoutMs,
    rootDir: resolve(rootDir), executable: input.executable,
    nodePath: input.nodePath, seedToken: input.seedToken,
  }
}

/**
 * Own the ZCode proxy process and its data directory.
 *
 * Readiness is proven by `/api/health` before any caller uses the endpoint,
 * and `close()` waits for the process to actually exit so a reload cannot
 * leave two listeners racing for the same port.
 */
export class ZcodeController {
  #process
  #closed = false

  /**
   * @param options - validated `resolveZcodeOptions` output.
   * @param subprocess - the DSH subprocess seam (`ctx.subprocess`).
   * @param args - optional logger, fetcher, and npm runner overrides.
   */
  constructor(options, subprocess, {
    log = console, fetcher = fetch, npmCliPath, runNpm, solverInstallTimeoutMs = 300000, spawnProcess = spawn,
  } = {}) {
    this.options = options
    this.subprocess = subprocess
    this.log = log
    this.fetcher = fetcher
    this.npmCliPath = npmCliPath
    this.runNpm = runNpm ?? defaultRunNpm
    this.spawnProcess = spawnProcess
    this.options.solverInstallTimeoutMs = solverInstallTimeoutMs
    this.endpoint = `http://127.0.0.1:${options.port}`
  }

  /** Directory the proxy runs in; upstream reads `.env` and `data/` from here. */
  get rootDir() { return this.options.rootDir }

  /** Seed-token file the proxy imports into its account pool at startup. */
  get tokensPath() { return join(this.options.rootDir, 'tokens.txt') }

  /**
   * Account token to seed the pool with, assigned by the caller after it reads
   * the machine's credential store; `undefined` leaves the pool untouched.
   */
  set seedToken(value) { this.options.seedToken = value }

  /** Start the proxy unless it is already answering, and wait for readiness. */
  async initialize() {
    if (await this.#healthy()) {
      this.log.info?.(`zcode: reusing proxy already listening at ${this.endpoint}`)
      // A reused proxy may have been started outside this plugin, or before a
      // dependency fix, so the same check runs on both paths.
      await this.#ensureSolverDependencies()
      await this.syncCredentials()
      return
    }
    const binary = await this.#resolveBinary()
    await this.#writeEnv()
    await this.#writeSeedToken()
    await this.#clearInterruptedUnpack()
    await this.#launch(binary)
    await this.#awaitReady()
    // The published release embeds the solver's packages, so this normally
    // finds them unpacked within seconds; it installs only when a build omits
    // them. No restart follows: the proxy spawns `node solver.js` per solve, so
    // packages added later are picked up by the next request.
    await this.#ensureSolverDependencies()
    await this.syncCredentials()
  }

  /**
   * Remove the unpack staging a previous run left behind.
   *
   * The proxy extracts the solver into `captcha_node.tmp` and renames it once
   * complete, so an interrupted run leaves that directory where the next launch
   * would extract over it.
   */
  async #clearInterruptedUnpack() {
    const staging = join(this.options.rootDir, 'data', 'captcha_node.tmp')
    await rm(staging, { recursive: true, force: true })
  }

  /**
   * Force the proxy's persisted admin and gateway keys to the configured value.
   *
   * `.env` only seeds an empty database: the proxy stores both keys in SQLite
   * and its own load order lets the stored value win, so a changed `authToken`
   * would otherwise leave the injected gateway connection authenticating with
   * a key the proxy no longer accepts.
   *
   * The stored key is unknowable from outside, so this probes: the configured
   * value is tried first, then `legacyAuthTokens`, and a proxy that accepts
   * neither is reported rather than silently left in a mismatched state. That
   * ordering matters on a first run, where no stored key exists yet and the
   * `.env` value is already correct.
   * @throws when neither candidate authorizes the write.
   */
  async syncCredentials() {
    const candidates = [this.options.authToken, ...this.options.legacyAuthTokens]
    const attempted = []
    for (const candidate of candidates) {
      if (attempted.includes(candidate)) continue
      attempted.push(candidate)
      const response = await fetch(`${this.endpoint}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${candidate}` },
        body: JSON.stringify({ admin_password: this.options.authToken, gateway_key: this.options.authToken }),
        signal: AbortSignal.timeout(10000),
      }).catch(error => {
        throw new Error(`zcode: could not reach the proxy settings API: ${error.message}`)
      })
      if (response.ok) {
        if (candidate !== this.options.authToken) {
          this.log.info?.(`zcode: migrated the proxy key from the previously stored value to zcode.authToken`)
        }
        return
      }
      if (response.status !== 401 && response.status !== 403) {
        throw new Error(`zcode: proxy settings API answered HTTP ${response.status}`)
      }
    }
    throw new Error(
      'zcode: proxy rejected every known password, so its stored key is neither the configured '
      + `zcode.authToken nor a listed zcode.legacyAuthTokens entry; set zcode.authToken to the proxy's `
      + `current password through its dashboard, or delete ${join(this.options.rootDir, 'data')} to re-seed it`,
    )
  }

  /** Stop the proxy and wait for the process to exit. */
  async close() {
    this.#closed = true
    await this.#stop()
  }

  /**
   * Terminate the managed process, waiting for it to actually exit.
   *
   * A proxy wedged mid-captcha can ignore the polite signal, so this escalates
   * rather than leaving a second listener racing for the same port.
   */
  async #stop() {
    const child = this.#process
    this.#process = undefined
    if (child === undefined || child.exitCode !== null) return
    const exited = new Promise(resolveExit => child.once('exit', resolveExit))
    child.kill()
    const forced = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await exited
    } finally {
      clearTimeout(forced)
    }
  }

  /** Locate the proxy executable, downloading the pinned release when enabled. */
  async #resolveBinary() {
    if (this.options.executable !== undefined) {
      if (!existsSync(this.options.executable)) {
        throw new Error(`zcode: configured executable does not exist: ${this.options.executable}`)
      }
      return this.options.executable
    }
    const managed = proxyBinaryPath(this.options.rootDir)
    if (existsSync(managed)) return managed
    if (!this.options.autoInstall) {
      throw new Error(
        `zcode: proxy binary not found at ${managed}. Set zcode.autoInstall to download the pinned `
        + 'release, or build https://github.com/D3-vin/Zcode2Api yourself and point zcode.executable at it.',
      )
    }
    this.log.info?.('zcode: downloading the zcode2api proxy binary (one time)')
    const installed = await installProxy(this.options.rootDir, { fetcher: this.fetcher })
    this.log.info?.(`zcode: installed proxy at ${installed}`)
    return installed
  }

  /**
   * Make sure the captcha solver's Node packages are present.
   *
   * The published release embeds them, so the normal path is a short wait for
   * the proxy to finish unpacking: `node_modules/happy-dom` is the marker,
   * because that package is what the solver's browser emulation imports. The
   * `npm install` below is a fallback for a build that omits them, and it is
   * deliberately non-fatal — a proxy without a working solver still serves its
   * dashboard, and failing here would discard the gateway's other providers.
   *
   * The unpack takes about ten seconds on a cold start (the proxy extracts to
   * `captcha_node.tmp` and renames), and longer while a virus scanner inspects
   * the freshly downloaded 25 MB binary, so the deadline is generous.
   * @returns whether packages had to be installed.
   * @throws when a fallback install is attempted and fails.
   */
  async #ensureSolverDependencies() {
    const solverDir = await solverDirectory(this.options.rootDir)
    const marker = join(solverDir, 'node_modules', 'happy-dom', 'package.json')
    if (await this.#awaitSolverPackages(marker)) return { installed: false }
    this.log.warn?.('zcode: the proxy did not unpack its solver packages; attempting an npm install')
    return installSolverDependencies({
      solverDir,
      nodePath: this.options.nodePath ?? 'node',
      npmCliPath: this.npmCliPath,
      exists: fileExists,
      runNpm: this.runNpm,
      timeoutMs: this.options.solverInstallTimeoutMs,
      log: this.log,
    })
  }

  /** Poll for the solver's marker file until the deadline. */
  async #awaitSolverPackages(marker) {
    const deadline = Date.now() + this.options.solverReadyTimeoutMs
    while (Date.now() < deadline) {
      if (await fileExists(marker)) return true
      await delay(500)
    }
    return false
  }

  /**
   * Write the proxy's `.env`.
   *
   * `AUTH_TOKEN` gates the dashboard and `/api/*`; `GATEWAY_KEY` is what the
   * consumed `/v1/*` endpoints require, and pinning it to a fixed value keeps
   * the provisioned 9router-go connection valid across plugin reloads.
   */
  async #writeEnv() {
    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 })
    const lines = [
      'HOST=127.0.0.1',
      `PORT=${this.options.port}`,
      `AUTH_TOKEN=${this.options.authToken}`,
      `GATEWAY_KEY=${this.options.authToken}`,
      'ZCODE_KEYS=tokens.txt',
      `CAPTCHA_SOLVE_TIMEOUT=${this.options.captchaTimeout}`,
      // The first mint against a cold CDN cache stalls by design; one retry
      // is what makes that normal lifecycle rather than a failed request.
      'CAPTCHA_RETRIES=3',
      '',
    ]
    await writeFile(join(this.options.rootDir, '.env'), lines.join('\n'), { mode: 0o600 })
  }

  /** Seed the pool from the configured token, if the caller supplied one. */
  async #writeSeedToken() {
    if (this.options.seedToken === undefined) return
    const token = this.options.seedToken.trim()
    if (token.length === 0) return
    await writeFile(this.tokensPath, `${token}\n`, { mode: 0o600 })
  }

  async #launch(binary) {
    if (this.#closed) throw new Error('zcode: controller is closed')
    const path = this.options.nodePath ?? process.env.PATH
    const child = this.spawnProcess(binary, [], {
      cwd: this.options.rootDir,
      env: this.options.nodePath === undefined
        ? { ...process.env }
        : { ...process.env, PATH: path },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#process = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // Forwarded to the debug log rather than buffered: the solver reports one
    // stall line per attempt and holding them would grow without bound.
    child.stdout?.on('data', chunk => this.log.debug?.(`zcode: ${String(chunk).trimEnd()}`))
    child.stderr?.on('data', chunk => this.log.debug?.(`zcode: ${String(chunk).trimEnd()}`))
    child.once('error', error => this.log.warn?.(`zcode: proxy process error: ${error.message}`))
    this.log.info?.(`zcode: started proxy ${binary} on port ${this.options.port}`)
  }

  async #awaitReady() {
    const deadline = Date.now() + this.options.startupTimeoutMs
    while (Date.now() < deadline) {
      const child = this.#process
      if (child !== undefined && child.exitCode !== null) {
        throw new Error(`zcode: proxy exited during startup with code ${child.exitCode}`)
      }
      if (await this.#healthy()) {
        this.log.info?.(`zcode: proxy ready at ${this.endpoint}`)
        return
      }
      await delay(500)
    }
    throw new Error(`zcode: proxy did not become healthy within ${this.options.startupTimeoutMs}ms`)
  }

  async #healthy() {
    try {
      const response = await fetch(`${this.endpoint}${HEALTH_PATH}`, { signal: AbortSignal.timeout(3000) })
      return response.ok
    } catch {
      // An unreachable port is the expected answer before launch and after
      // teardown; readiness polling is the caller's concern, not an error.
      return false
    }
  }
}

/**
 * Read the ZCode refresh token this plugin seeds into the proxy pool.
 *
 * The ZCode desktop app stores credentials encrypted with AES-256-GCM under a
 * key derived from `ZCODE_CREDENTIAL_SECRET` plus platform, home and user. That
 * secret is absent on a default install, so the derived key is reproducible.
 * @param options - credential store location and derived-key inputs.
 * @returns the JWT string, or undefined when the store holds none.
 * @throws when the store exists but cannot be decrypted, so a real breakage
 *   is reported instead of silently starting a proxy with no account.
 */
export async function readZcodeToken({
  credentialsPath, platform = process.platform, home, username, secret = process.env.ZCODE_CREDENTIAL_SECRET ?? '',
  createDecipheriv, createHash,
} = {}) {
  if (createDecipheriv === undefined || createHash === undefined) {
    throw new Error('readZcodeToken requires Node crypto primitives')
  }
  let store
  try {
    store = JSON.parse(await readFile(credentialsPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error(`zcode: credential store is unreadable: ${error.message}`)
  }
  const name = Object.keys(store).find(key => key.endsWith('zcodejwttoken') || key === 'zcodejwttoken')
  if (name === undefined) return undefined
  const raw = store[name]
  if (typeof raw !== 'string' || !raw.startsWith('enc:v1:')) return undefined
  const [iv, tag, ciphertext] = raw.slice('enc:v1:'.length).split('.')
  if (iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new Error('zcode: credential entry is not in the expected enc:v1:<iv>.<tag>.<ct> form')
  }
  const decode = value => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const key = createHash('sha256')
    .update(`${secret}zcode-credential-fallback:${platform}:${home}:${username}`)
    .digest()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decode(iv))
    decipher.setAuthTag(decode(tag))
    return Buffer.concat([decipher.update(decode(ciphertext)), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new Error(`zcode: could not decrypt the stored ZCode credential: ${error.message}`)
  }
}
