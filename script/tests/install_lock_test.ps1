$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "install_lock.ps1")

$Root = Join-Path $env:TEMP ("LightningLoop-Install-Lock-Test-" + [guid]::NewGuid().ToString("N"))
$LockPath = Join-Path $Root "install.lock"
$First = $null
$Third = $null
try {
    $First = Open-LightningLoopInstallLock $LockPath
    $Rejected = $false
    try {
        $Second = Open-LightningLoopInstallLock $LockPath
        Close-LightningLoopInstallLock $Second
    } catch {
        $Rejected = $true
    }
    if (-not $Rejected) { throw "Concurrent contender unexpectedly acquired the install lock." }
    if (-not $First.CanWrite) { throw "Rejected contender invalidated the owner's install lock." }
    Close-LightningLoopInstallLock $First
    $First = $null
    $Third = Open-LightningLoopInstallLock $LockPath
    if (-not $Third.CanWrite) { throw "Released install lock could not be acquired again." }
    $Recreated = Join-Path $Root "recreated-target"
    Set-Content -LiteralPath $Recreated -Value "recreated" -NoNewline
    $TargetRejected = $false
    try { Assert-LightningLoopLiveTargetAbsent $Recreated "fixture" } catch { $TargetRejected = $true }
    if (-not $TargetRejected) { throw "Recreated live target was not rejected." }

    $CrossVolumeRejected = $false
    try { Assert-LightningLoopSameVolume "C:\LightningLoop\live" "D:\LightningLoop\stage" } catch { $CrossVolumeRejected = $true }
    if (-not $CrossVolumeRejected) { throw "Cross-volume staging was not rejected." }

    $JunctionTarget = New-LightningLoopSafeDirectory (Join-Path $Root "junction-target")
    $Junction = Join-Path $Root "junction"
    $JunctionOutput = & cmd.exe /d /c "mklink /J `"$Junction`" `"$JunctionTarget`"" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not create the reparse-point fixture: $($JunctionOutput -join ' ')" }
    $ReparseRejected = $false
    try { New-LightningLoopSafeDirectory (Join-Path $Junction "unsafe-child") | Out-Null } catch { $ReparseRejected = $true }
    if (-not $ReparseRejected) { throw "A destination beneath a junction was not rejected." }

    $DirectorySource = New-LightningLoopSafeDirectory (Join-Path $Root "directory-source")
    [System.IO.File]::WriteAllText((Join-Path $DirectorySource "payload.txt"), "trusted")
    $DirectoryDestination = Join-Path $Root "directory-destination"
    Assert-LightningLoopLiveTargetAbsent $DirectoryDestination "directory race fixture"
    [System.IO.Directory]::CreateDirectory($DirectoryDestination) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $DirectoryDestination "attacker.txt"), "attacker")
    $DirectoryRaceRejected = $false
    try { Move-LightningLoopDirectoryNoReplace $DirectorySource $DirectoryDestination "directory race fixture" } catch { $DirectoryRaceRejected = $true }
    if (-not $DirectoryRaceRejected) { throw "Recreated directory target was replaced or nested into." }
    if (-not (Test-Path -LiteralPath (Join-Path $DirectorySource "payload.txt") -PathType Leaf)) { throw "Rejected directory race consumed the trusted source." }
    if ([System.IO.File]::ReadAllText((Join-Path $DirectoryDestination "attacker.txt")) -ne "attacker") { throw "Rejected directory race changed the attacker target." }
    if (Test-Path -LiteralPath (Join-Path $DirectoryDestination "directory-source")) { throw "Directory race nested the staged package into the recreated target." }

    $FileSource = Join-Path $Root "file-source.cmd"
    $FileDestination = Join-Path $Root "file-destination.cmd"
    [System.IO.File]::WriteAllText($FileSource, "trusted")
    Assert-LightningLoopLiveTargetAbsent $FileDestination "file race fixture"
    [System.IO.File]::WriteAllText($FileDestination, "attacker")
    $FileRaceRejected = $false
    try { Move-LightningLoopFileNoReplace $FileSource $FileDestination "file race fixture" } catch { $FileRaceRejected = $true }
    if (-not $FileRaceRejected) { throw "Recreated file target was replaced." }
    if ([System.IO.File]::ReadAllText($FileSource) -ne "trusted") { throw "Rejected file race consumed the trusted source." }
    if ([System.IO.File]::ReadAllText($FileDestination) -ne "attacker") { throw "Rejected file race replaced the attacker target." }

    $SuccessfulDirectorySource = New-LightningLoopSafeDirectory (Join-Path $Root "successful-directory-source")
    [System.IO.File]::WriteAllText((Join-Path $SuccessfulDirectorySource "payload.txt"), "trusted")
    $SuccessfulDirectoryDestination = Join-Path $Root "successful-directory-destination"
    Move-LightningLoopDirectoryNoReplace $SuccessfulDirectorySource $SuccessfulDirectoryDestination "successful directory fixture"
    if ((Test-Path -LiteralPath $SuccessfulDirectorySource) -or -not (Test-Path -LiteralPath (Join-Path $SuccessfulDirectoryDestination "payload.txt") -PathType Leaf)) {
        throw "Successful directory move did not satisfy its postcondition."
    }

    $SuccessfulFileSource = Join-Path $Root "successful-file-source.cmd"
    $SuccessfulFileDestination = Join-Path $Root "successful-file-destination.cmd"
    [System.IO.File]::WriteAllText($SuccessfulFileSource, "trusted")
    Move-LightningLoopFileNoReplace $SuccessfulFileSource $SuccessfulFileDestination "successful file fixture"
    if ((Test-Path -LiteralPath $SuccessfulFileSource) -or [System.IO.File]::ReadAllText($SuccessfulFileDestination) -ne "trusted") {
        throw "Successful file move did not satisfy its postcondition."
    }

    Write-Host "PASS: Windows install locking, same-volume staging, reparse rejection, and no-replace moves fail closed."
} finally {
    Close-LightningLoopInstallLock $Third
    Close-LightningLoopInstallLock $First
    if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
