<#
.SYNOPSIS
  Install dsh-9router-go into the DSH Desktop profile.

.DESCRIPTION
  The Desktop application owns $DSH_HOME/profiles/desktop exclusively, so
  `dsh plugin --profile desktop` refuses every command. This script performs the
  same operation the application's Plugins page does:

    1. optionally writes a profile-private .npmrc holding a registry and token;
    2. installs the package with the Node and pnpm the Desktop application ships;
    3. adds the bundle to the profile's dsh.profile.bundles list.

  Nothing is written outside the profile, so the machine-global npm
  configuration is left alone.

.PARAMETER Registry
  Registry to install from. Omit it to use the registry npm already resolves,
  which is what a public installation needs.

.PARAMETER Token
  Read token for -Registry. Defaults to $env:MM_NPM_TOKEN. Omit it when this
  machine already authenticates through npm's own configuration; the profile
  then keeps whatever that configuration provides.

.PARAMETER Version
  Published version to install. Defaults to the registry's `latest` tag, so the
  shipped script never installs a stale version.

.PARAMETER HarnessHome
  Harness home holding profiles/. Defaults to $env:DSH_HOME, then ~/.dsh.

.PARAMETER AppPath
  Desktop application directory. Discovered from the running application, the
  uninstall records, or the default install locations when omitted.

.EXAMPLE
  ./install-desktop.ps1

.EXAMPLE
  ./install-desktop.ps1 -Registry https://npm.example.com/ -Token <token>
#>
[CmdletBinding()]
param(
  [string] $Package = 'dsh-9router-go',
  [string] $Version = '',
  [string] $Registry = '',
  [string] $Token = $env:MM_NPM_TOKEN,
  [string] $HarnessHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string] $AppPath
)

$ErrorActionPreference = 'Stop'

function Find-DesktopApp {
  param([string] $Explicit)
  if ($Explicit) {
    if (Test-Path (Join-Path $Explicit 'resources\runtime')) { return $Explicit }
    throw "AppPath '$Explicit' does not look like a DeepSeek Harness installation."
  }
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path } | Select-Object -First 1
  if ($running) { return Split-Path -Parent $running.Path }
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in Get-ItemProperty $roots -ErrorAction SilentlyContinue) {
    if ($key.DisplayName -like '*DeepSeek Harness*' -and $key.InstallLocation) {
      $candidate = $key.InstallLocation.Trim('"')
      if (Test-Path (Join-Path $candidate 'resources\runtime')) { return $candidate }
    }
  }
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness')
  )) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'resources\runtime'))) { return $candidate }
  }
  throw 'DeepSeek Harness was not found. Start it once, or pass -AppPath.'
}

# The Desktop runtime is the only package manager every colleague is known to
# have; a PATH pnpm is accepted as the last resort rather than the first choice.
function Resolve-PackageTool {
  param([string] $App)
  $candidates = @()
  if ($App) {
    $deps = Join-Path $App 'resources\runtime\primary-runtime\dependencies'
    $candidates += [pscustomobject]@{
      Node = Join-Path $deps 'node\bin\node.exe'
      Pnpm = Join-Path $deps 'pnpm\bin\pnpm.mjs'
    }
  }
  $candidates += [pscustomobject]@{
    Node = Join-Path $HarnessHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    Pnpm = Join-Path $HarnessHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
  }
  foreach ($candidate in $candidates) {
    if ((Test-Path $candidate.Node) -and (Test-Path $candidate.Pnpm)) { return $candidate }
  }
  $pathPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pathPnpm) { return [pscustomobject]@{ Node = $null; Pnpm = $pathPnpm.Source } }
  throw 'No pnpm was found. Start DeepSeek Harness once so it unpacks its runtime, or install pnpm.'
}

function Add-BundleSelection {
  param([string] $ManifestPath, [string] $Bundle)
  $manifest = (Read-Utf8Text -Path $ManifestPath) | ConvertFrom-Json
  if ($manifest.dsh.profile.bundles -contains $Bundle) { return $false }
  $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles) + $Bundle
  Write-Utf8Text -Path $ManifestPath -Text ($manifest | ConvertTo-Json -Depth 12)
  return $true
}

# Windows PowerShell reads and writes text with the machine's ANSI code page by
# default, which mangles the UTF-8 comments these profile files already carry.
# Every read and write below therefore goes through an explicit encoder.
function Read-Utf8Text {
  param([string] $Path)
  return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-Utf8Text {
  param([string] $Path, [string] $Text)
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-Utf8Lines {
  param([string] $Path)
  return [System.IO.File]::ReadAllLines($Path, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-Utf8Lines {
  param([string] $Path, [string[]] $Lines)
  [System.IO.File]::WriteAllLines($Path, [string[]] $Lines, (New-Object System.Text.UTF8Encoding($false)))
}

# pnpm refuses a registry version newer than its minimumReleaseAge window. The
# exemption is keyed by package name so it also covers the next release; a
# version-pinned entry would let the following release fail to resolve.
function Add-ReleaseAgeExclusion {
  param([string] $WorkspacePath, [string] $Entry)
  $lines = @(if (Test-Path $WorkspacePath) { Read-Utf8Lines -Path $WorkspacePath } else { @('packages:', '  - .') })
  if ($lines -match "^\s*-\s*'?$([regex]::Escape($Entry))'?\s*$") { return $false }
  $key = ($lines | Select-String -Pattern '^minimumReleaseAgeExclude:' | Select-Object -First 1).LineNumber
  if ($key) {
    $insertAt = $key
    while ($insertAt -lt $lines.Count -and $lines[$insertAt] -match '^\s*-\s') { $insertAt++ }
    $lines = @($lines[0..($key - 1)]) + @("  - '$Entry'") + @($lines[$key..($lines.Count - 1)])
  } else {
    $lines = $lines + @('minimumReleaseAgeExclude:', "  - '$Entry'")
  }
  Write-Utf8Lines -Path $WorkspacePath -Lines $lines
  return $true
}

# Ask the registry which version is current rather than trusting a value baked
# into this file, which would go stale on every release. With an explicit token
# the plain metadata endpoint answers; without one pnpm answers, because only
# pnpm reads the machine's own credential configuration.
function Resolve-LatestVersion {
  param([string] $Registry, [string] $Package, [string] $Token, [string] $Node, [string] $Pnpm)
  $registryArgs = if ($Registry) { @('--registry', $Registry) } else { @() }
  if ($Token) {
    $base = if ($Registry.EndsWith('/')) { $Registry } else { "$Registry/" }
    $metadata = Invoke-RestMethod -Uri "$base$($Package.Replace('/', '%2F'))" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 30
    $latest = $metadata.'dist-tags'.latest
  } else {
    $latest = if ($Node) { & $Node $Pnpm view $Package version @registryArgs 2>$null } else { & $Pnpm view $Package version @registryArgs 2>$null }
    $latest = @($latest) | Select-Object -Last 1
  }
  $latest = "$latest".Trim()
  if (-not $latest) { throw "Could not resolve the latest $Package version. Pass -Token and -Registry, or configure npm credentials for the registry you meant." }
  return $latest
}

$profile = Join-Path $HarnessHome 'profiles\desktop'
if (-not (Test-Path $profile)) {
  throw "No Desktop profile at $profile. Start DeepSeek Harness once, then run this again."
}

$app = Find-DesktopApp -Explicit $AppPath
$tool = Resolve-PackageTool -App $app

if (-not $Version) { $Version = Resolve-LatestVersion -Registry $Registry -Package $Package -Token $Token -Node $tool.Node -Pnpm $tool.Pnpm }
Write-Host "installing $Package@$Version"

# The profile is its own pnpm workspace, so this file is the project-private
# equivalent of a machine-global registry setting. It is written only for a
# registry the caller named; otherwise the profile is left alone so the
# machine's own npm configuration still applies.
if ($Token) {
  if (-not $Registry) { throw '-Token needs -Registry: a token cannot be stored without the registry it authenticates to.' }
  # npm addresses a credential as `//host/path/:key`; dropping the scheme from
  # the registry URL already leaves exactly those two leading slashes.
  $authority = $Registry -replace '^https?:', ''
  if (-not $authority.EndsWith('/')) { $authority += '/' }
  $npmrc = Join-Path $profile '.npmrc'
  @(
    "registry=$Registry"
    "${authority}:_authToken=$Token"
  ) | Set-Content $npmrc -Encoding ascii
  Write-Host "registry configured for this profile only: $npmrc"
} elseif ($Registry) {
  Write-Host "using $Registry with the npm credentials already configured on this machine"
} else {
  Write-Host 'using the registry npm already resolves'
}

$env:CI = 'true'
if ($Registry) { $env:npm_config_registry = $Registry }
Add-ReleaseAgeExclusion -WorkspacePath (Join-Path $profile 'pnpm-workspace.yaml') -Entry $Package | Out-Null

if ($tool.Node) {
  Write-Verbose "using $($tool.Node)"
  & $tool.Node $tool.Pnpm --dir $profile add "$Package@$Version" --prefer-offline --reporter=append-only
} else {
  & $tool.Pnpm --dir $profile add "$Package@$Version" --prefer-offline --reporter=append-only
}
if ($LASTEXITCODE -ne 0) {
  throw "pnpm exited with code $LASTEXITCODE. On E401/E403 supply -Token: $Registry requires authentication and no credential on this machine matched it."
}

if (Add-BundleSelection -ManifestPath (Join-Path $profile 'package.json') -Bundle $Package) {
  Write-Host "enabled bundle $Package"
} else {
  Write-Host "bundle $Package was already enabled"
}

Write-Host ''
Write-Host "Installed $Package@$Version into the Desktop profile." -ForegroundColor Green
Write-Host 'Restart DeepSeek Harness to load the plugin, then open the sidebar Plugins list to confirm it.'
Write-Host ''
# The ZCode proxy the plugin manages needs Node at runtime, and its absence
# only surfaces as failing model requests later. Reporting it here turns a
# confusing failure into a prerequisite the operator can satisfy now.
$nodeOnPath = Get-Command node -ErrorAction SilentlyContinue
if (-not $tool.Node -and -not $nodeOnPath) {
  Write-Host 'Note: no Node.js was found on PATH.' -ForegroundColor Yellow
  Write-Host 'The optional ZCode proxy needs it for its captcha solver; the 9router-go gateway alone does not.' -ForegroundColor Yellow
} else {
  Write-Host 'The managed ZCode proxy is enabled by default. On first start it downloads its pinned' -ForegroundColor DarkGray
  Write-Host 'binary and installs its captcha solver packages, which takes about a minute.' -ForegroundColor DarkGray
}
