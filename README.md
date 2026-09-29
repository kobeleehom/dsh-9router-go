# 9router-go for DeepSeek Harness

English | [简体中文](README.zh-CN.md)

Independent DSH bundle: starts the unmodified [9router-go](https://github.com/luqman-v1/9router-go) executable as a loopback-only sidecar, verifies upstream GitHub Release downloads and optionally follows new releases. The upstream executable and its Dashboard are **not included** in this package.

> ⚠️ **Read [Licensing and trust](#licensing-and-trust) before use**: upstream has no LICENSE, and the plugin downloads and runs upstream's **unsigned** executable. That is a real risk, not boilerplate.

---

## Install

Three routes; pick one. **Do not use `dsh plugin` for Desktop** — see below.

### Route 1: npx (recommended, Desktop)

```powershell
npx --yes dsh-9router-go install-desktop
```

From public npm, **no credentials needed**. It uses the Node and pnpm the Desktop application ships to install into the profile and select the bundle. **Restart DeepSeek Harness** afterwards.

### Route 2: the Desktop Plugins page

Sidebar → **Plugins** → install `dsh-9router-go` → confirm the bundle is enabled. Equivalent to Route 1, for anyone who prefers the GUI.

### Route 3: from source (development)

```powershell
git clone https://github.com/kobeleehom/dsh-9router-go
cd dsh-9router-go
npm run check          # 21 tests
```

Into a Web profile:

```powershell
pnpm dsh plugin --profile web add ..\dsh-9router-go
pnpm dsh --profile web --dump-config
```

For Desktop from a checkout (Desktop owns its profile, so the CLI cannot manage it):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-desktop.ps1
```

### Why Desktop cannot use `dsh plugin`

The Desktop application owns `$DSH_HOME/profiles/desktop` exclusively, and `dsh --profile desktop` **refuses every command**, including `dsh plugin` ([`args.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/cli/src/args.ts)). Desktop therefore goes through the Plugins page or the installer script — both do the same thing: run pnpm against the profile directory and select the bundle.

See [INSTALL-DESKTOP.md](INSTALL-DESKTOP.md) for the details.

### After installing

Open the Dashboard with the `/9router-go` command (it loads in the sidebar Browser on Desktop), or browse to `http://127.0.0.1:20130`. The model provider is **injected automatically** — see [Connect DSH models](#connect-dsh-models).

---

## Licensing and trust

As checked during development, the upstream repository has no `LICENSE` file and GitHub reports `license: null`. Its original inspiration `decolua/9router` being MIT does **not** establish a license for the Go implementation. Do not redistribute the upstream executable with this bundle without permission from its copyright holders. Enabling `autoInstall` deliberately downloads and runs upstream's unsigned executable under your user account; the plugin verifies its GitHub Release SHA-256 digest and native file header, but this does not replace a signature or security audit. Only use it if you accept the upstream project's code, provider terms and licensing implications.

## Usage notes

Run the profile as usual. Open the Dashboard with the `/9router-go` command, which loads it in the sidebar Browser on Desktop, or browse to `http://127.0.0.1:20130` directly. Desktop mounts that Browser tab type by default; Web profiles do not, so the command reports itself unavailable there. OAuth, downloads, and popups in the Dashboard still need a system browser.

The browser boot row carries no plugin configuration, so the command's target address is the `DASHBOARD_URL` constant in `client.js`. Changing `port` therefore also requires editing that one line; DSH logs a warning when the configured port differs from it.

The initial Dashboard password is stored at `<DSH_HOME>/9router-go/initial-password` and is never printed in logs. Change it in the Dashboard after first login.

A separate DSH CLI installation can use `dsh plugin --profile web add <absolute-plugin-directory>` for a checkout, or `dsh plugin --profile web add dsh-9router-go` when the registry it resolves serves the package. Local linked packages need their own dependencies only if you add new runtime imports; this bundle uses Node's standard library plus the Host `subprocess` service.

### Connect DSH models

The plugin publishes itself as a DSH model provider on first activation, so no manual setup is normally required. It derives the gateway's local CLI token from the data directory, creates an API key named `dsh-9router-go`, stores the key through the DSH credential seam as `NINEROUTER_GO_API_KEY`, and appends one `llm-pi-ai` route holding the models the gateway reports as connected. The write is additive: existing providers keep serving. A route some adapter already serves makes the step a no-op, so reloads never rewrite your configuration.

Equivalently, in **Settings → Models** you can add a **Custom model API** provider manually:

- Provider ID: `9router-go`
- Protocol: OpenAI Chat Completions (`openai-completions`)
- API base URL: `http://127.0.0.1:20130/v1`
- Key reference: `NINEROUTER_GO_API_KEY`
- Model ID: one actual ID or combo name from the running Dashboard or its authenticated `GET /v1/models`

Do not add a second `llm-pi-ai` entry: every instance advertises the whole installed catalog, so two collide, and the Models page only edits the entry whose id is `llm-pi-ai`. Disabling the plugin leaves an injected route in place; remove it from the Models page if you no longer want it.

### ZCode (GLM-5.3-Flash) accounts

A ZCode (Z.ai) account is not an OpenAI-compatible endpoint, so the gateway cannot speak to it directly. The plugin owns a second sidecar for this: it launches [`zcode2api`](https://github.com/D3-vin/Zcode2Api), which republishes the account as an OpenAI-compatible endpoint, and then registers that proxy **into** the gateway as a custom provider. Going through the gateway rather than exposing the proxy to DSH is what keeps the ZCode models addressable by the gateway's own combos and fallbacks.

This is enabled by this bundle's patch and needs no manual setup on a first run. On activation the plugin:

1. downloads the pinned `zcode2api` release binary from `D3-vin/Zcode2Api`, verifying its published SHA-256 and native executable header before publishing it;
2. starts the proxy once so it unpacks its captcha solver, installs that solver's Node packages with `npm install`, and restarts it; and
3. registers the proxy into the gateway as a custom provider with the models listed below, then publishes the gateway route to DSH.

Expect the first activation to take roughly a minute — a 25 MB download plus one `npm install`. Later activations are about a second: the binary, its dependencies and its data directory are all reused, and neither download nor install repeats.

Two prerequisites remain: **Node.js on `PATH`** (the captcha solver is a Node program) and **a ZCode account**. When `zcode.seedToken` is omitted the plugin reads the token from the ZCode desktop app's own credential store (`~/.zcode/v2/credentials.json`, AES-256-GCM under a key derived from `ZCODE_CREDENTIAL_SECRET` plus platform, home and user). If that store is absent the proxy still starts with an empty pool and you can sign in through its dashboard at `http://127.0.0.1:<zcode.port>`.

Once registered, the models appear as `zcode/GLM-5.3-Flash` and are listed by the gateway's authenticated `GET /v1/models`. Expect the first request to take roughly 15–30 seconds: the captcha solver stalls once against a cold CDN cache and succeeds on retry, which is its documented normal lifecycle. Later requests reuse the cached parameter and answer in a few seconds.

```yaml
- id: 9router-go
  config:
    zcode:
      enabled: true
      autoInstall: true
      port: 3101
      routeName: zcode
      routePrefix: zcode
      models:
        - GLM-5.3-Flash
      startupTimeoutMs: 60000
      captchaTimeout: 60s
      authToken: dsh-zcode-local
```

**A note on licensing and trust.** `zcode2api` publishes no open-source license (its README says as-is, and GitHub reports `license: null`). `zcode.autoInstall` therefore has this plugin download and run a third-party binary under your user account. The plugin verifies the release SHA-256 digest and the native file header, which detects a corrupted or substituted download but is not a signature or a security audit. To opt out, set `autoInstall: false` and point `executable` at a build you produced yourself; the two options are mutually exclusive and the plugin refuses a configuration that sets both.

`authToken` is the password the proxy requires on `/v1/*`. It is written into the proxy's `.env` **and** pushed through the proxy's settings API on every activation, because the proxy persists its password in SQLite and lets that stored value win over `.env` — seeding the file alone would leave the gateway connection authenticating with a key the proxy no longer accepts. If you change `authToken`, list the previous value under `legacyAuthTokens` so the plugin can migrate the stored key rather than being locked out; the plugin tries the configured value first, then each legacy entry, and reports a proxy whose password matches none of them. `routeName` is the provider node's unique name, which is how repeated reloads repoint the existing node instead of adding duplicates. `models` declares what the proxy exposes — the gateway lists custom models from its own store and does not probe a custom node's `/v1/models`, so a node with no registered model stays invisible to clients even though its connection is active.

Known limitations worth stating plainly. This works by driving a third-party reverse-engineered client flow, so an upstream change to ZCode's captcha or identity checks breaks it until that project catches up; the plugin treats its failures as soft, logging a warning and leaving the gateway serving your other providers. Upstream `GLM-5.3` also answered `529 Overloaded` during development while `GLM-5.3-Flash` served normally, so the account's non-flash entitlement is not guaranteed.

## Runtime configuration and updates

The bundle's entry ID is `9router-go`. Override its **whole** config in the profile's `cordis.patch.yml` if you need a different port or root directory:

```yaml
- id: 9router-go
  config:
    port: 20130
    rootDir: C:\Users\example\9router-go-data
    autoInstall: true
    autoUpdate: true
    checkIntervalHours: 6
    startupTimeoutMs: 30000
    shutdownGraceMs: 5000
    provider:
      autoInject: true
      routeName: 9router-go
      settingsNamespace: llm-pi-ai
      apiKeyEnv: NINEROUTER_GO_API_KEY
      keyName: dsh-9router-go
      maxModels: 40
      inputModalities:
        - text
```

`rootDir` defaults to `<DSH_HOME>/9router-go`; the runtime, data, Dashboard password and version pointer live there separately from the npm plugin. On startup, `autoInstall: true` downloads a verified official release when no managed version exists. `autoUpdate: true` checks GitHub Releases every `checkIntervalHours` and switches to a verified newer binary after stopping the old process; default `false` keeps the installed version until you explicitly enable updates. Host plugins can declare `inject = ['nineRouterGo']` and call `ctx.nineRouterGo.checkUpdate()` or `await ctx.nineRouterGo.update()` to check or update manually; the service also exposes `endpoint`, `version`, `running`, and `dataDir`. There is no dedicated update button in DSH's UI. An explicitly configured absolute `executable` disables managed upgrades, letting you install and update 9router-go yourself.

`provider.autoInject` defaults to `false` in code and is enabled by this bundle's patch. `settingsNamespace` must name the profile entry that owns the routes (the shipped `llm-pi-ai` entry); `routeName`, `apiKeyEnv`, and `keyName` name the injected route, its credential reference, and the gateway API key. `maxModels` caps how many connected models are listed, and `inputModalities` declares what those models accept, because the gateway's catalog reports no modalities — the shipped `text` default refuses images rather than sending a provider a request it may reject mid-turn.


On an upgrade, the plugin preserves `<rootDir>/data`, stages the new binary, waits for the old managed process to exit, copies the quiescent data directory under `<rootDir>/backups`, then checks `/health` before writing the new active-version pointer. A backup failure aborts the upgrade and restarts the old binary. If the upgraded process fails readiness, the plugin waits for its exit, restores the pre-upgrade data snapshot and restarts the old binary; it retains the modified directory as `<rootDir>/failed-upgrade-*` for recovery. Requests accepted by the new process before the readiness failure can be lost during this restore. Backup or restore failures leave diagnostic data on disk and can prevent automatic recovery. Backups are retained until you remove them; keep an additional off-machine backup before enabling unattended updates. Never share one data directory across two live instances. The plugin takes an exclusive `.dsh-owner` directory lock; after an abrupt host crash, verify the old process has exited before manually removing a stale lock.

The upstream app's own `AUTO_UPDATE` environment is set to `false`, but its persisted Dashboard setting can re-enable its in-place updater; keep the Dashboard's auto-update toggle **off**. The upstream `version.json` currently points at a release landing page rather than a platform executable, so this plugin uses GitHub Release assets and their digests instead. This plugin does not proxy the Dashboard or expose its credentials on the DSH origin. The gateway uses the dedicated loopback port; Codex OAuth may also require port 1455.

## Test

Run `npm run check` in this project for syntax, checksum, size, native-header, ownership, lifecycle, provisioning and browser-bundle tests. For a real integration, use a separate `web`-derived DSH profile, install this directory as a bundle, start the profile with a different DSH Web port (`--port 0 --no-open`), then run `npm run test:live`. That smoke signs in with the private first-login password, creates a temporary API key, reads the authenticated `/v1/models` list, and deletes the key in a `finally` block. Disable the entry through the live profile patch to verify DSH stops the gateway and releases its directory lock. Live download requires GitHub access; without it, set `autoInstall: false` and provide an absolute `executable` path obtained from upstream by the operator.

Automatic injection is verifiable without opening the UI: after the profile boots, the injected route appears under the `settingsNamespace` entry in the profile's `cordis.patch.yml`, the key appears under `refs:` in `$DSH_HOME/.credentials.yaml`, and the served page's `window.__DSH_BOOT__` graph lists a `dsh-9router-go` row whose `client.js` under `/plugins` returns the bundle.

