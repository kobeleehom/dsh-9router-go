# Installing in DSH Desktop

Desktop-specific notes for `dsh-9router-go`. For the plugin's behaviour, configuration, and update policy, read [README.md](README.md).

## Why the CLI cannot install it

The Desktop application owns `$DSH_HOME/profiles/desktop` exclusively, and `dsh --profile desktop` refuses every command — `dsh plugin` included ([`apps/cli/src/args.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/cli/src/args.ts)). The application's own **Plugins** page is the supported route; the bundled installer performs the same package operation against the profile directory.

## Install

### Plugins page

Sidebar → **Plugins** → install `dsh-9router-go` → confirm the bundle is enabled. This needs the package to be resolvable from whatever registry your DSH installation already uses.

### Bundled installer

```powershell
npx --yes dsh-9router-go install-desktop
```

Or, from a checkout, run the script directly:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-desktop.ps1
```

Either way the script:

1. resolves the newest published version (or takes `--version`);
2. installs with the Node and pnpm the Desktop application ships, so no separate Node installation is needed;
3. adds the bundle to the profile's `dsh.profile.bundles`.

It writes nothing outside the profile, so a machine-global npm configuration is left alone. `--help` lists every option.

### From a local checkout

To develop against a working copy, install it as a link and select the bundle by hand:

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm --dir $profile add "link:<path-to-your-checkout>"
```

Then append `dsh-9router-go` to `dsh.profile.bundles` in `$profile\package.json`. Back up `package.json` and `pnpm-lock.yaml` first, and never run this while the Plugins page has an installation in progress. A running Desktop recomposes a manifest change without a restart.

## Private registries

`-Registry` selects the registry and `-Token` supplies its read token; the script then writes a **profile-private** `.npmrc` rather than touching `~/.npmrc`.

```powershell
npx --yes dsh-9router-go install-desktop --registry https://npm.example.com/ --token <token>
```

Omit `--token` when the machine already authenticates through npm's own configuration — that is the usual case, and the common public installation needs no registry option at all.

## After installing

Restart DeepSeek Harness so the plugin's Host module and browser half load. Then verify:

| Check | Expected |
|---|---|
| `http://127.0.0.1:20130/health` | `{"status":"ok"}` |
| Settings → Models | a `9Router` provider, listing the models the gateway reports as connected |
| `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` | an `llm-pi-ai` entry carrying a `9router-go` route |
| `%USERPROFILE%\.dsh\.credentials.yaml` | `NINEROUTER_GO_API_KEY` under `refs:` |
| `/9router-go` in a session | opens the Dashboard in the sidebar Browser |

The initial Dashboard password is stored at `%USERPROFILE%\.dsh\9router-go\initial-password`; change it after first login. The gateway API key is created automatically — there is nothing to configure by hand.

If the `/9router-go` command does not appear, reload the page (Ctrl+R); if it still does not, restart Desktop, because the browser half loads with a fresh process.

## Offline

Set `autoInstall: false` in the profile's `cordis.patch.yml` and point `executable` at a binary you obtained yourself:

```yaml
- id: 9router-go
  config:
    autoInstall: false
    executable: D:\tools\9router-go\9router-go-windows-amd64.exe
```

A configured `executable` also disables the plugin's own update channel, leaving upgrades to you.

## Uninstall

Remove `dsh-9router-go` from the Plugins page. That stops the gateway and releases its data-directory lock. An injected model route is **not** removed — delete the `9Router` provider in Settings → Models and the `NINEROUTER_GO_API_KEY` reference if you want it gone. The runtime directory `%USERPROFILE%\.dsh\9router-go` is left in place; delete it yourself if you no longer need the data.
