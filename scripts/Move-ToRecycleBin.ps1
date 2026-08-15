[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
)

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($LiteralPath)
if ([IO.Path]::GetPathRoot($target).ToUpperInvariant() -ne 'A:\') {
    throw "Recycle Bin target must be on drive A: $target"
}
if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    throw "Directory does not exist: $target"
}

Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $target,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
    [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
)

if (Test-Path -LiteralPath $target) {
    throw "Directory still exists after Recycle Bin operation: $target"
}
