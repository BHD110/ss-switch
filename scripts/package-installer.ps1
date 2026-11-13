param(
  [string]$Version
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopPackage = Join-Path $repoRoot "apps/bridge-desktop/package.json"
$installerScript = Join-Path $repoRoot "apps/bridge-desktop/installer/ss-switch.iss"
$unpackedExe = Join-Path $repoRoot "release/win-unpacked/ss switch.exe"

if (-not $Version) {
  $Version = (Get-Content $desktopPackage -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
  throw "Version must be in x.y.z format: $Version"
}
if (-not (Test-Path $unpackedExe)) {
  throw "Missing $unpackedExe. Run pnpm package:win first."
}

$compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $compiler) {
  foreach ($programFiles in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if (-not $programFiles) { continue }
    $candidate = Join-Path $programFiles "Inno Setup 6/ISCC.exe"
    if (Test-Path $candidate) {
      $compiler = $candidate
      break
    }
  }
}
if (-not $compiler) {
  throw "Inno Setup 6 (ISCC.exe) is required to build the installer."
}

& $compiler "/DAppVersion=$Version" $installerScript
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE."
}
