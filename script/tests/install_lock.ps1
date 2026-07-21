function Open-LightningLoopInstallLock {
    param([Parameter(Mandatory = $true)][string]$Path)

    $FullPath = [System.IO.Path]::GetFullPath($Path)
    $Parent = Split-Path -Parent $FullPath
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    try {
        return [System.IO.File]::Open(
            $FullPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch [System.IO.IOException] {
        throw "Another LightningLoop install holds the exclusive lock $FullPath"
    }
}

function Close-LightningLoopInstallLock {
    param([System.IO.FileStream]$Lease)
    if ($null -ne $Lease) {
        $Lease.Flush()
        $Lease.Dispose()
    }
}

function Assert-LightningLoopLiveTargetAbsent {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
    if (Test-Path -LiteralPath $Path) {
        throw "Live $Label target was recreated during installation: $Path"
    }
}

function Assert-LightningLoopPathHasNoReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)
    $FullPath = [System.IO.Path]::GetFullPath($Path)
    $Root = [System.IO.Path]::GetPathRoot($FullPath)
    $Current = $Root
    $Remainder = $FullPath.Substring($Root.Length)
    foreach ($Segment in $Remainder.Split([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $Current = Join-Path $Current $Segment
        if (Test-Path -LiteralPath $Current) {
            $Item = Get-Item -LiteralPath $Current -Force
            if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Install path contains a reparse point or junction: $Current"
            }
        }
    }
    return $FullPath
}

function New-LightningLoopSafeDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $FullPath = Assert-LightningLoopPathHasNoReparsePoint $Path
    [System.IO.Directory]::CreateDirectory($FullPath) | Out-Null
    Assert-LightningLoopPathHasNoReparsePoint $FullPath | Out-Null
    return (Resolve-Path -LiteralPath $FullPath).ProviderPath
}

function Assert-LightningLoopSameVolume {
    param([Parameter(Mandatory = $true)][string]$Left, [Parameter(Mandatory = $true)][string]$Right)
    $LeftRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Left))
    $RightRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Right))
    if (-not [string]::Equals($LeftRoot, $RightRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Install staging and backups must remain on the live target volume ($LeftRoot != $RightRoot)."
    }
}

function Move-LightningLoopDirectoryNoReplace {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $SourcePath = Assert-LightningLoopPathHasNoReparsePoint $Source
    $DestinationPath = [System.IO.Path]::GetFullPath($Destination)
    Assert-LightningLoopPathHasNoReparsePoint (Split-Path -Parent $DestinationPath) | Out-Null
    Assert-LightningLoopSameVolume $SourcePath $DestinationPath
    if (Get-ChildItem -LiteralPath $SourcePath -Recurse -Force | Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1) {
        throw "$Label contains a reparse point."
    }
    try {
        [System.IO.Directory]::Move($SourcePath, $DestinationPath)
    } catch {
        throw "Could not exclusively move $Label to $DestinationPath`: $($_.Exception.Message)"
    }
    if ((Test-Path -LiteralPath $SourcePath) -or -not (Test-Path -LiteralPath $DestinationPath -PathType Container)) {
        throw "$Label no-replace move did not establish the expected postcondition."
    }
    Assert-LightningLoopPathHasNoReparsePoint $DestinationPath | Out-Null
}

function Move-LightningLoopFileNoReplace {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $SourcePath = Assert-LightningLoopPathHasNoReparsePoint $Source
    $DestinationPath = [System.IO.Path]::GetFullPath($Destination)
    $SourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
    $SourceLength = (Get-Item -LiteralPath $SourcePath -Force).Length
    Assert-LightningLoopPathHasNoReparsePoint (Split-Path -Parent $DestinationPath) | Out-Null
    Assert-LightningLoopSameVolume $SourcePath $DestinationPath
    try {
        [System.IO.File]::Move($SourcePath, $DestinationPath)
    } catch {
        throw "Could not exclusively move $Label to $DestinationPath`: $($_.Exception.Message)"
    }
    if ((Test-Path -LiteralPath $SourcePath) -or -not (Test-Path -LiteralPath $DestinationPath -PathType Leaf)) {
        throw "$Label no-replace move did not establish the expected postcondition."
    }
    Assert-LightningLoopPathHasNoReparsePoint $DestinationPath | Out-Null
    if ((Get-Item -LiteralPath $DestinationPath -Force).Length -ne $SourceLength -or (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash -ne $SourceHash) {
        throw "$Label bytes changed during the no-replace move."
    }
}
