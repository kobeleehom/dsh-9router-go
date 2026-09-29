/**
 * Automatic model-route provisioning for the DSH sidecar.
 *
 * The plugin owns the gateway's data directory, so it can derive the same local
 * CLI token the gateway accepts (`sha256(machineId + "9r-cli-auth" + cliSecret)`)
 * and read its own machine facts without a password. It uses that token to
 * provision a client API key, stores the key through the DSH credential seam,
 * and appends one `llm-pi-ai` provider route through the settings service.
 *
 * The settings write is additive: `ctx.settings.update` deep-merges plain
 * objects, so every provider the deployment already configured keeps serving.
 * @module dsh-9router-go/provision
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Salt upstream mixes into the dashboard CLI token (`src/shared/utils/machineId.js`). */
const CLI_TOKEN_SALT = '9r-cli-auth'

/** Header the gateway accepts in place of a dashboard session for local callers. */
export const CLI_TOKEN_HEADER = 'x-9r-cli-token'

/** Byte counts upstream generates for the two CLI-token inputs. */
const MACHINE_ID_BYTES = 16
const CLI_SECRET_BYTES = 32

/**
 * Derive the gateway's local dashboard CLI token from its own data directory.
 *
 * Both inputs are generated on first use by upstream's own `readOrCreateHexFile`,
 * so this creates them when absent and re-reads on a lost create race. A fresh
 * data directory therefore provisions without any dashboard interaction.
 * @param dataDir - the `DATA_DIR` the managed gateway runs with.
 * @returns the 16-character hex token the gateway computes for this machine.
 * @throws when a stored input is not the hex value upstream would have written.
 */
export async function deriveCliToken(dataDir) {
  const machineId = await ensureHexSecret(join(dataDir, 'machine-id'), MACHINE_ID_BYTES)
  const cliSecret = await ensureHexSecret(join(dataDir, 'auth', 'cli-secret'), CLI_SECRET_BYTES)
  return createHash('sha256').update(machineId + CLI_TOKEN_SALT + cliSecret).digest('hex').slice(0, 16)
}

async function ensureHexSecret(path, bytes) {
  const expected = bytes * 2
  const stored = await readSecret(path)
  if (stored !== undefined) return assertHexSecret(stored, path, expected)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const generated = randomBytes(bytes).toString('hex')
  try {
    await writeFile(path, generated, { flag: 'wx', mode: 0o600 })
    return generated
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const raced = await readSecret(path)
    if (raced === undefined) throw new Error(`gateway secret ${path} disappeared during creation`)
    return assertHexSecret(raced, path, expected)
  }
}

function assertHexSecret(value, path, expected) {
  if (value.length !== expected || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`gateway secret ${path} is not the expected ${expected}-character lowercase hex value`)
  }
  return value
}

async function readSecret(path) {
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return value.length > 0 ? value : undefined
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function readJson(response, what) {
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`)
  try {
    return await response.json()
  } catch (error) {
    throw new Error(`${what} returned invalid JSON: ${error.message}`)
  }
}

/**
 * Reuse the gateway API key this plugin created earlier, or create one.
 * @param options - gateway endpoint, CLI token, key name, fetcher, and deadline.
 * @returns the `sk-` API key value.
 * @throws when the gateway refuses the request or returns no usable key.
 */
export async function ensureApiKey({ endpoint, token, keyName, fetcher = fetch, timeoutMs = 10000 }) {
  const headers = { [CLI_TOKEN_HEADER]: token }
  const listed = await fetcher(`${endpoint}/api/keys`, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const keys = await readJson(listed, 'listing gateway API keys')
  const match = Array.isArray(keys)
    ? keys.find(entry => entry?.name === keyName && typeof entry.key === 'string' && entry.key.startsWith('sk-'))
    : undefined
  if (match !== undefined) return match.key
  const created = await fetcher(`${endpoint}/api/keys`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: keyName }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await readJson(created, 'creating a gateway API key')
  if (typeof body?.key !== 'string' || !body.key.startsWith('sk-')) {
    throw new Error('gateway key creation returned no usable key')
  }
  return body.key
}

/**
 * Read the model ids the gateway currently serves to this key.
 * @param options - gateway endpoint, API key, model cap, fetcher, and deadline.
 * @returns distinct model ids in gateway order, at most `maxModels`.
 * @throws when the catalog request fails or reports no model at all.
 */
export async function connectedModelIds({ endpoint, key, maxModels, fetcher = fetch, timeoutMs = 15000 }) {
  const response = await fetcher(`${endpoint}/v1/models?connected=1`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await readJson(response, 'reading the gateway model catalog')
  const ids = [...new Set((Array.isArray(body?.data) ? body.data : [])
    .map(entry => entry?.id)
    .filter(id => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) throw new Error('gateway reported no connected model; connect a provider in its dashboard first')
  return ids.slice(0, maxModels)
}

/**
 * Append the gateway as one `llm-pi-ai` route when no adapter serves it yet.
 *
 * A route already registered by any adapter leaves this a no-op, which is what
 * keeps repeated plugin reloads from rewriting the deployment's configuration.
 * @param options - injected services, gateway facts, route settings, fetcher, and logger.
 * @returns whether the route was written.
 * @throws when key provisioning, catalog reading, or the settings write fails.
 */
export async function provisionModelRoute({
  settings, credentials, llm, endpoint, dataDir, provider, fetcher = fetch, log = console,
}) {
  const served = llm.listProviders().some(entry => entry.id === provider.routeName)
  if (served) return { injected: false, reason: 'route-already-registered' }
  const token = await deriveCliToken(dataDir)
  const key = await ensureApiKey({ endpoint, token, keyName: provider.keyName, fetcher })
  const models = await connectedModelIds({ endpoint, key, maxModels: provider.maxModels, fetcher })
  await credentials.set(provider.apiKeyEnv, key)
  await settings.update(provider.settingsNamespace, {
    providers: {
      [provider.routeName]: {
        displayName: '9Router',
        apiKeyEnv: provider.apiKeyEnv,
        api: 'openai-completions',
        baseURL: `${endpoint}/v1`,
        models: models.map(id => ({ id, input: [...provider.inputModalities] })),
      },
    },
  })
  log.info(`9router-go: registered model route "${provider.routeName}" with ${models.length} model(s)`)
  return { injected: true, models }
}
