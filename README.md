# 9router-go for DeepSeek Harness

Independent DSH bundle: starts the unmodified [9router-go](https://github.com/luqman-v1/9router-go) executable as a loopback-only sidecar, verifies upstream GitHub Release downloads and optionally follows new releases. The upstream executable and its Dashboard are **not included** in this package.

## Licensing and trust

As checked during development, the upstream repository has no `LICENSE` file and GitHub reports `license: null`. Its original inspiration `decolua/9router` being MIT does **not** establish a license for the Go implementation. Do not redistribute the upstream executable with this bundle without permission from its copyright holders. Enabling `autoInstall` deliberately downloads and runs upstream's unsigned executable under your user account; the plugin verifies its GitHub Release SHA-256 digest and native file header, but this does not replace a signature or security audit. Only use it if you accept the upstream project's code, provider terms and licensing implications.

## Install

**Desktop users should follow [INSTALL-DESKTOP.md](INSTALL-DESKTOP.md)**: the Desktop application owns its profile, so the `dsh` CLI cannot install there and the Plugins page (or the bundled installer) does it instead.

From a DSH source checkout, install into an existing Web profile (or a disposable profile created from `web`):

```powershell
pnpm dsh plugin --profile web add ..\dsh-9router-go
pnpm dsh --profile web --dump-config
```

A separate DSH CLI installation can use `dsh plugin --profile web add <absolute-plugin-directory>` for a checkout, or `dsh plugin --profile web add dsh-9router-go` once the package is published to the registry that installation resolves. Local linked packages need their own dependencies only if you add new runtime imports; this bundle uses Node's standard library plus the Host `subprocess` service.

### Desktop

The Desktop application owns `$DSH_HOME/profiles/desktop` exclusively, and `dsh --profile desktop` refuses every command, including `dsh plugin` ([`args.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/cli/src/args.ts)). Install through the application's **Plugins** page, or run the bundled installer, which does the same thing against the profile directory:

```powershell
npx --yes dsh-9router-go install-desktop
```

Both routes leave the machine-global npm configuration alone. [INSTALL-DESKTOP.md](INSTALL-DESKTOP.md) documents the details, including installing a local checkout and targeting a private registry.

Run the profile as usual. Open the Dashboard with the `/9router-go` command, which loads it in the sidebar Browser on Desktop, or browse to `http://127.0.0.1:20130` directly. Desktop mounts that Browser tab type by default; Web profiles do not, so the command reports itself unavailable there. OAuth, downloads, and popups in the Dashboard still need a system browser.

The browser boot row carries no plugin configuration, so the command's target address is the `DASHBOARD_URL` constant in `client.js`. Changing `port` therefore also requires editing that one line; DSH logs a warning when the configured port differs from it.

The initial Dashboard password is stored at `<DSH_HOME>/9router-go/initial-password` and is never printed in logs. Change it in the Dashboard after first login.

### Connect DSH models

The plugin publishes itself as a DSH model provider on first activation, so no manual setup is normally required. It derives the gateway's local CLI token from the data directory, creates an API key named `dsh-9router-go`, stores the key through the DSH credential seam as `NINEROUTER_GO_API_KEY`, and appends one `llm-pi-ai` route holding the models the gateway reports as connected. The write is additive: existing providers keep serving. A route some adapter already serves makes the step a no-op, so reloads never rewrite your configuration.

Equivalently, in **Settings → Models** you can add a **Custom model API** provider manually:

- Provider ID: `9router-go`
- Protocol: OpenAI Chat Completions (`openai-completions`)
- API base URL: `http://127.0.0.1:20130/v1`
- Key reference: `NINEROUTER_GO_API_KEY`
- Model ID: one actual ID or combo name from the running Dashboard or its authenticated `GET /v1/models`

Do not add a second `llm-pi-ai` entry: every instance advertises the whole installed catalog, so two collide, and the Models page only edits the entry whose id is `llm-pi-ai`. Disabling the plugin leaves an injected route in place; remove it from the Models page if you no longer want it.

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

