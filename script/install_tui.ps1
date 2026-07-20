param(
    [string]$Prefix = "",
    [string]$BackupRoot = "",
    [ValidateSet("", "backup", "commit", "smoke")]
    [string]$TestFailAt = "",
    # CI-only preflight probe. This never changes which executable runs.
    [string]$TestNodeVersion = ""
)

# Install the packed Windows TUI without running package lifecycle hooks.  The
# commit step is deliberately recoverable: the old package and every shim this
# package owns are moved aside before the staged package becomes live.
$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $RootDir "script\\tests\\install_lock.ps1")
Set-Location $RootDir
$PackagePath = $null
$StagePrefix = $null
$InstallLockStream = $null

function Assert-SupportedNodeVersion {
    param([string]$Version)

    if ($Version -notmatch '^[vV]?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:[-+].*)?$') {
        throw "Node.js reported an unparseable version: $Version"
    }
    $Major = [int]$Matches.major
    $Minor = [int]$Matches.minor
    if ($Major -lt 22 -or ($Major -eq 22 -and $Minor -lt 19)) {
        throw "LightningLoop requires Node.js 22.19.0 or newer; found $Version."
    }
}

function Invoke-Checked {
    param(
        [string]$Description,
        [scriptblock]$Command
    )

    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

function Invoke-Tui {
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [string]$Description
    )

    if ([System.IO.Path]::IsPathRooted($Executable) -and -not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw "$Description executable is missing: $Executable"
    }
    if (-not [System.IO.Path]::IsPathRooted($Executable) -and -not (Get-Command $Executable -ErrorAction SilentlyContinue)) {
        throw "$Description command is unavailable: $Executable"
    }
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

function Get-PackageOwnedAliasNames {
    param([string]$PackageDirectory)

    $ManifestPath = Join-Path $PackageDirectory "package.json"
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return @() }
    Assert-LightningLoopPathHasNoReparsePoint $PackageDirectory | Out-Null
    Assert-LightningLoopPathHasNoReparsePoint $ManifestPath | Out-Null
    $ManifestFile = Get-Item -LiteralPath $ManifestPath
    if ($ManifestFile.Length -gt 262144) { throw "Installed package manifest exceeds 256 KiB." }
    try {
        $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    } catch {
        throw "Installed LightningLoop package manifest is invalid: $($_.Exception.Message)"
    }
    if ($null -eq $Manifest.bin) { return @() }
    if (-not ($Manifest.bin -is [pscustomobject])) {
        throw "Installed LightningLoop package uses an unsupported bin manifest."
    }
    $Aliases = @($Manifest.bin.PSObject.Properties.Name | Sort-Object -Unique)
    if ($Aliases.Count -gt 32) { throw "Installed LightningLoop package declares more than 32 aliases." }
    foreach ($Alias in $Aliases) {
        if ($Alias -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
            throw "Installed LightningLoop package declares an unsafe alias: $Alias"
        }
    }
    return $Aliases
}

function Assert-LiveTargetAbsent {
    param([string]$Path, [string]$Label)
    Assert-LightningLoopLiveTargetAbsent $Path $Label
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22.19+ and npm are required." }
if ([string]::IsNullOrWhiteSpace($TestNodeVersion)) {
    $ReportedNodeVersion = (& node --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Node.js 22.19+ and npm are required." }
} else {
    $ReportedNodeVersion = $TestNodeVersion
}
Assert-SupportedNodeVersion $ReportedNodeVersion

# Source verification builds dist.  Neither the verification install, pack,
# nor staged install is allowed to run lifecycle scripts.
Invoke-Checked "npm ci --ignore-scripts" { & npm ci --ignore-scripts }
Invoke-Checked "portable harness verification" { & npm run test:portable }
$PackageName = (& npm pack --ignore-scripts --silent | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($PackageName)) {
    throw "npm pack --ignore-scripts did not produce an archive."
}
$PackagePath = Join-Path $RootDir $PackageName
if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf) -or [System.IO.Path]::GetExtension($PackagePath) -ne ".tgz") {
    throw "npm pack returned an invalid archive path."
}
Invoke-Tui "node" @((Join-Path $RootDir "script\\tests\\locked_runtime_manifest.mjs"), "archive", (Join-Path $RootDir "package-lock.json"), $PackagePath) "packed archive provenance"
$PackedArchiveHash = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash

$LivePrefix = if ([string]::IsNullOrWhiteSpace($Prefix)) {
    (& npm prefix --global).Trim()
} else {
    [System.IO.Path]::GetFullPath($Prefix)
}
if ([string]::IsNullOrWhiteSpace($LivePrefix)) { throw "Could not resolve the npm install prefix." }
$LivePrefix = New-LightningLoopSafeDirectory $LivePrefix

$StagePrefix = Join-Path $LivePrefix (".lightningloop-tui-stage-" + [guid]::NewGuid().ToString("N"))
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    $BackupRoot = Join-Path $LivePrefix (".lightningloop-backups\\" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ"))
} else {
    $BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
}
Assert-LightningLoopSameVolume $LivePrefix $StagePrefix
Assert-LightningLoopSameVolume $LivePrefix $BackupRoot
Assert-LightningLoopPathHasNoReparsePoint $BackupRoot | Out-Null

$LockBytes = [System.Text.Encoding]::UTF8.GetBytes($LivePrefix.ToUpperInvariant())
$LockDigest = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($LockBytes)).ToLowerInvariant()
$InstallLockPath = Join-Path $env:LOCALAPPDATA ("LightningLoop\\InstallerLocks\\" + $LockDigest + ".lock")

$PackageRelative = "node_modules\\@barnlabs\\lightningloop-harness"
$LivePackage = Join-Path $LivePrefix $PackageRelative
$StagePackage = Join-Path $StagePrefix $PackageRelative
$RuntimeManifestName = ".lightningloop-runtime-manifest.json"
$LockVerifier = Join-Path $RootDir "script\\tests\\locked_runtime_manifest.mjs"
$Names = @("lightningloop", "lloop", "llp")
$ShimSuffixes = @("", ".cmd", ".ps1")
$OwnedNames = $Names
$CommitStarted = $false
$CommitComplete = $false
$MovedOldPackage = $false
$MovedOldShims = @()
$InstalledNewPackage = $false
$InstalledNewShims = @()

function Restore-LightningLoopTUI {
    # Remove only new paths that this transaction installed. A failure during
    # the backup phase must not delete old aliases that were never moved.
    $RollbackErrors = [System.Collections.Generic.List[string]]::new()
    foreach ($LiveShim in $InstalledNewShims) {
        if (Test-Path -LiteralPath $LiveShim) {
            try { Remove-Item -LiteralPath $LiveShim -Force } catch { $RollbackErrors.Add("remove $LiveShim`: $($_.Exception.Message)") }
        }
    }
    if ($InstalledNewPackage -and (Test-Path -LiteralPath $LivePackage)) {
        try { Remove-Item -LiteralPath $LivePackage -Recurse -Force } catch { $RollbackErrors.Add("remove $LivePackage`: $($_.Exception.Message)") }
    }
    foreach ($Moved in $MovedOldShims) {
        if (Test-Path -LiteralPath $Moved.Saved) {
            if (Test-Path -LiteralPath $Moved.Live) {
                $RollbackErrors.Add("refusing to replace recreated shim $($Moved.Live)")
            } else {
                try { Move-LightningLoopFileNoReplace $Moved.Saved $Moved.Live "saved TUI shim" } catch { $RollbackErrors.Add("restore $($Moved.Live)`: $($_.Exception.Message)") }
            }
        } else {
            $RollbackErrors.Add("missing shim backup $($Moved.Saved)")
        }
    }
    if ($MovedOldPackage) {
        $SavedPackage = Join-Path $BackupRoot "tui-package"
        if (Test-Path -LiteralPath $SavedPackage) {
            if (Test-Path -LiteralPath $LivePackage) {
                $RollbackErrors.Add("refusing to replace recreated package target $LivePackage")
            } else {
                try { Move-LightningLoopDirectoryNoReplace $SavedPackage $LivePackage "saved TUI package" } catch { $RollbackErrors.Add("restore $LivePackage`: $($_.Exception.Message)") }
            }
        } else {
            $RollbackErrors.Add("missing package backup $SavedPackage")
        }
    }
    if ($RollbackErrors.Count -gt 0) {
        throw "TUI rollback was incomplete: $($RollbackErrors -join '; ')"
    }
}

try {
    $InstallLockStream = Open-LightningLoopInstallLock $InstallLockPath
} catch {
    if (-not [string]::IsNullOrWhiteSpace($PackagePath) -and (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
        Remove-Item -LiteralPath $PackagePath -Force
    }
    throw
}

try {
    $StagePrefix = New-LightningLoopSafeDirectory $StagePrefix
    Invoke-Checked "offline staged TUI installation" {
        & npm install --global --ignore-scripts --offline --prefix $StagePrefix $PackagePath
    }
    if ((Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash -ne $PackedArchiveHash) {
        throw "Package archive changed during extraction."
    }

    # npm's global install creates the Windows shims only. Its dependency
    # resolution is discarded and replaced with a production-only npm ci from
    # the reviewed lock. Record package versions and byte trees now, then
    # verify the same manifest after the recoverable move.
    $StageDependencies = Join-Path $StagePackage "node_modules"
    if (Test-Path -LiteralPath $StageDependencies) {
        Remove-Item -LiteralPath $StageDependencies -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $RootDir "package-lock.json") -Destination (Join-Path $StagePackage "package-lock.json")
    Invoke-Checked "lock-bound staged production dependency install" {
        & npm ci --omit=dev --ignore-scripts --offline --prefix $StagePackage
    }
    Invoke-Checked "staged production dependency validation" {
        & npm ls --omit=dev --all --prefix $StagePackage
    }
    Invoke-Tui "node" @($LockVerifier, "write", (Join-Path $RootDir "package-lock.json"), $StagePackage, (Join-Path $StagePackage $RuntimeManifestName), $PackagePath) "staged lock manifest"
    $StagedRuntimeManifestHash = (Get-FileHash -LiteralPath (Join-Path $StagePackage $RuntimeManifestName) -Algorithm SHA256).Hash

    # Smoke the staged bytes before any live package or shim is moved.
    Invoke-Tui (Join-Path $StagePrefix "llp.cmd") @("help") "staged llp"
    Invoke-Tui (Join-Path $StagePrefix "lloop.cmd") @("help") "staged lloop"
    Invoke-Tui "node" @((Join-Path $StagePackage "dist\\cli\\index.js"), "help") "staged CLI"

    $PriorNames = @(Get-PackageOwnedAliasNames $LivePackage)
    $OwnedNames = @($Names + $PriorNames | Sort-Object -Unique)
    New-LightningLoopSafeDirectory (Split-Path $LivePackage) | Out-Null
    New-LightningLoopSafeDirectory (Join-Path $BackupRoot "bin") | Out-Null
    Assert-LightningLoopPathHasNoReparsePoint $LivePrefix | Out-Null
    Assert-LightningLoopPathHasNoReparsePoint $StagePrefix | Out-Null
    Assert-LightningLoopPathHasNoReparsePoint $BackupRoot | Out-Null
    $CommitStarted = $true
    if (Test-Path -LiteralPath $LivePackage) {
        $SavedPackage = Join-Path $BackupRoot "tui-package"
        try {
            Move-LightningLoopDirectoryNoReplace $LivePackage $SavedPackage "existing TUI package backup"
        } catch {
            if (-not (Test-Path -LiteralPath $LivePackage) -and (Test-Path -LiteralPath $SavedPackage -PathType Container)) { $MovedOldPackage = $true }
            throw
        }
        $MovedOldPackage = $true
    }
    foreach ($Name in $OwnedNames) {
        foreach ($Suffix in $ShimSuffixes) {
            $LiveShim = Join-Path $LivePrefix ($Name + $Suffix)
            if (Test-Path -LiteralPath $LiveShim) {
                $SavedShim = Join-Path $BackupRoot ("bin\\" + $Name + $Suffix)
                try {
                    Move-LightningLoopFileNoReplace $LiveShim $SavedShim "existing TUI shim backup"
                } catch {
                    if (-not (Test-Path -LiteralPath $LiveShim) -and (Test-Path -LiteralPath $SavedShim -PathType Leaf)) {
                        $MovedOldShims += [pscustomobject]@{ Live = $LiveShim; Saved = $SavedShim }
                    }
                    throw
                }
                $MovedOldShims += [pscustomobject]@{ Live = $LiveShim; Saved = $SavedShim }
                if ($TestFailAt -eq "backup" -and $MovedOldShims.Count -eq 1) {
                    throw "Synthetic mid-backup failure."
                }
            }
        }
    }

    if ($TestFailAt -eq "commit") { throw "Synthetic commit failure." }
    try {
        Move-LightningLoopDirectoryNoReplace $StagePackage $LivePackage "staged TUI package"
    } catch {
        if (-not (Test-Path -LiteralPath $StagePackage) -and (Test-Path -LiteralPath $LivePackage -PathType Container)) { $InstalledNewPackage = $true }
        throw
    }
    $InstalledNewPackage = $true
    foreach ($Name in $Names) {
        foreach ($Suffix in $ShimSuffixes) {
            $StageShim = Join-Path $StagePrefix ($Name + $Suffix)
            if (-not (Test-Path -LiteralPath $StageShim -PathType Leaf)) { throw "Staged npm shim is missing: $StageShim" }
            $LiveShim = Join-Path $LivePrefix ($Name + $Suffix)
            try {
                Move-LightningLoopFileNoReplace $StageShim $LiveShim "staged TUI shim"
            } catch {
                if (-not (Test-Path -LiteralPath $StageShim) -and (Test-Path -LiteralPath $LiveShim -PathType Leaf)) { $InstalledNewShims += $LiveShim }
                throw
            }
            $InstalledNewShims += $LiveShim
        }
    }

    $InstalledRuntimeManifestHash = (Get-FileHash -LiteralPath (Join-Path $LivePackage $RuntimeManifestName) -Algorithm SHA256).Hash
    if ($InstalledRuntimeManifestHash -ne $StagedRuntimeManifestHash) { throw "Installed packed-root and dependency manifest changed during commit." }
    Invoke-Tui "node" @($LockVerifier, "verify", (Join-Path $RootDir "package-lock.json"), $LivePackage, (Join-Path $LivePackage $RuntimeManifestName), $PackagePath) "installed lock manifest"
    if ($TestFailAt -eq "smoke") { throw "Synthetic smoke failure." }
    Invoke-Tui (Join-Path $LivePrefix "llp.cmd") @("help") "installed llp"
    Invoke-Tui (Join-Path $LivePrefix "lloop.cmd") @("help") "installed lloop"
    Invoke-Tui "node" @((Join-Path $LivePackage "dist\\cli\\index.js"), "doctor", "--runtime-only") "installed CLI"
    $CommitComplete = $true
} catch {
    $InstallError = $_
    if ($CommitStarted -and -not $CommitComplete) {
        try {
            Restore-LightningLoopTUI
        } catch {
            throw "Installation failed: $($InstallError.Exception.Message) Rollback also failed: $($_.Exception.Message)"
        }
    }
    throw $InstallError
} finally {
    $CleanupErrors = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($PackagePath) -and (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
        try { Remove-Item -LiteralPath $PackagePath -Force } catch { $CleanupErrors.Add("package cleanup: $($_.Exception.Message)") }
    }
    if (-not [string]::IsNullOrWhiteSpace($StagePrefix) -and (Test-Path -LiteralPath $StagePrefix)) {
        try { Remove-Item -LiteralPath $StagePrefix -Recurse -Force } catch { $CleanupErrors.Add("staging cleanup: $($_.Exception.Message)") }
    }
    try { Close-LightningLoopInstallLock $InstallLockStream } catch { $CleanupErrors.Add("install-lock release: $($_.Exception.Message)") }
    if ($CleanupErrors.Count -gt 0) { throw "Installer cleanup was incomplete: $($CleanupErrors -join '; ')" }
}

Write-Host "LightningLoop TUI installed and smoke-tested. Run 'llp' or 'lloop' to open it."
