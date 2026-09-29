#!/usr/bin/env node
/**
 * Command-line entry for `dsh-9router-go`.
 *
 * `install-desktop` installs the plugin into the DeepSeek Harness Desktop
 * profile. It delegates to the PowerShell installer shipped beside it, so the
 * `npx` route and the no-Node bootstrap route run one implementation.
 * @module dsh-9router-go/bin
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'install-desktop.ps1')

/** CLI flags mapped onto the installer's PowerShell parameter names. */
const OPTIONS = new Map([
  ['--token', '-Token'],
  ['-t', '-Token'],
  ['--version', '-Version'],
  ['-v', '-Version'],
  ['--registry', '-Registry'],
  ['-r', '-Registry'],
  ['--harness-home', '-HarnessHome'],
  ['--app-path', '-AppPath'],
])

const USAGE = `Usage: dsh-9router-go install-desktop [options]

Installs dsh-9router-go into the DeepSeek Harness Desktop profile and enables
it as a bundle. Requires PowerShell, which every Windows target has.

Options:
  -t, --token <token>          read token for --registry (default: $MM_NPM_TOKEN)
                               omit it when this machine already authenticates
                               to the registry through npm's configuration
  -v, --version <version>      version to install (default: the registry's latest)
  -r, --registry <url>         registry to install from (default: npm's own)
      --harness-home <dir>     harness home holding profiles/
      --app-path <dir>         DeepSeek Harness installation directory
  -h, --help                   show this message

Reads MM_NPM_TOKEN from the environment when --token is absent.
`

/**
 * Translate `--flag value` and `--flag=value` into PowerShell parameters.
 * @param argv - arguments after the command name.
 * @returns the installer's argument list.
 * @throws when an option is unknown or missing its value.
 */
function translate(argv) {
  const out = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const split = argument.indexOf('=')
    const flag = split === -1 ? argument : argument.slice(0, split)
    const name = OPTIONS.get(flag)
    if (name === undefined) throw new Error(`unknown option "${argument}"`)
    const inline = split === -1 ? undefined : argument.slice(split + 1)
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    out.push(name, value)
  }
  return out
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(USAGE)
  process.exit(command === undefined ? 0 : 0)
}
if (command !== 'install-desktop') {
  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`)
  process.exit(1)
}
if (process.platform !== 'win32') {
  process.stderr.write('install-desktop targets a Windows DeepSeek Harness installation.\n')
  process.exit(1)
}
if (!existsSync(INSTALLER)) {
  process.stderr.write(`the bundled installer is missing: ${INSTALLER}\n`)
  process.exit(1)
}

let args
try {
  args = translate(rest)
} catch (error) {
  process.stderr.write(`${error.message}\n\n${USAGE}`)
  process.exit(1)
}

const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, ...args], {
  stdio: 'inherit',
  env: process.env,
})
if (result.error !== undefined) {
  process.stderr.write(`could not start PowerShell: ${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
