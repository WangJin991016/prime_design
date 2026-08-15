param(
    [string]$DotnetPath = '',
    [string]$NodeArchive = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = Join-Path $projectRoot 'dist\PrimerDesign-portable-win-x64'
$stagingRoot = Join-Path $projectRoot '.build-temp\portable-stage'
$dotnetCliRoot = Join-Path $projectRoot '.build-temp\dotnet-cli-home'
$nugetPackages = Join-Path $projectRoot '.build-temp\nuget-packages'
$portableDotnet = Join-Path $projectRoot 'vendor\dotnet\sdk-8.0.424\dotnet.exe'
$dotnet = if ($DotnetPath) {
    $DotnetPath
} elseif (Test-Path -LiteralPath $portableDotnet -PathType Leaf) {
    $portableDotnet
} else {
    (Get-Command dotnet.exe -ErrorAction Stop).Source
}

function New-PortableZip {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )
    Add-Type -AssemblyName System.IO.Compression
    $zipStream = [IO.File]::Open($DestinationPath, 'CreateNew', 'Write', 'None')
    try {
        $archive = [IO.Compression.ZipArchive]::new($zipStream, 'Create', $false)
        try {
            foreach ($file in (Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | Sort-Object FullName)) {
                $entryName = $file.FullName.Substring($SourceRoot.Length).TrimStart('\').Replace('\', '/')
                $entry = $archive.CreateEntry($entryName, 'Optimal')
                $entryStream = $entry.Open()
                try {
                    # Windows security scanners can briefly hold a newly built EXE.
                    # Sharing reads/writes/deletes keeps packaging deterministic without killing them.
                    $input = [IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite,Delete')
                    try { $input.CopyTo($entryStream) } finally { $input.Dispose() }
                } finally { $entryStream.Dispose() }
            }
        } finally { $archive.Dispose() }
    } finally { $zipStream.Dispose() }
}

if (-not $NodeArchive) {
    $NodeArchive = Join-Path $projectRoot 'vendor\node\node-v24.18.0-win-x64.zip'
}
if (-not (Test-Path -LiteralPath $NodeArchive -PathType Leaf)) { throw "Node archive not found: $NodeArchive" }
if (-not (Test-Path -LiteralPath $dotnet -PathType Leaf)) { throw "dotnet executable not found: $dotnet" }
New-Item -ItemType Directory -Path $dotnetCliRoot,$nugetPackages -Force | Out-Null
$env:DOTNET_CLI_HOME = $dotnetCliRoot
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:NUGET_PACKAGES = $nugetPackages

if (Test-Path -LiteralPath $stagingRoot) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $stagingRoot,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
        [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
    )
}
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
$nodeStage = Join-Path $stagingRoot 'node'
Expand-Archive -LiteralPath $NodeArchive -DestinationPath $nodeStage -Force
$nodeRoot = Get-ChildItem -LiteralPath $nodeStage -Directory | Select-Object -First 1
if (-not $nodeRoot) { throw 'Node archive has no root directory.' }

& $dotnet publish (Join-Path $projectRoot 'launcher\PrimerDesignLauncher\PrimerDesignLauncher.csproj') `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:PublishTrimmed=false `
    -o (Join-Path $stagingRoot 'launcher')
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed: $LASTEXITCODE" }

if (Test-Path -LiteralPath $distRoot) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $distRoot,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
        [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
    )
}
New-Item -ItemType Directory -Path $distRoot,(Join-Path $distRoot 'runtime\node'),(Join-Path $distRoot 'app'),(Join-Path $distRoot 'licenses') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $stagingRoot 'launcher\PrimerDesign.exe') -Destination (Join-Path $distRoot 'PrimerDesign.exe')
Copy-Item -LiteralPath (Join-Path $nodeRoot.FullName 'node.exe') -Destination (Join-Path $distRoot 'runtime\node\node.exe')
Copy-Item -LiteralPath (Join-Path $nodeRoot.FullName 'LICENSE') -Destination (Join-Path $distRoot 'runtime\node\LICENSE')
Copy-Item -LiteralPath (Join-Path (Split-Path $dotnet -Parent) 'LICENSE.txt') -Destination (Join-Path $distRoot 'licenses\dotnet-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path (Split-Path $dotnet -Parent) 'ThirdPartyNotices.txt') -Destination (Join-Path $distRoot 'licenses\dotnet-THIRD-PARTY-NOTICES.txt')
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination (Join-Path $distRoot 'app\package.json')
New-Item -ItemType Directory -Path (Join-Path $distRoot 'app\src\lib'),(Join-Path $distRoot 'app\src\web'),(Join-Path $distRoot 'app\config'),(Join-Path $distRoot 'app\scripts\server') -Force | Out-Null
foreach ($sourceFile in @('app.mjs','web-app.mjs','batch-cli.mjs')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "src\$sourceFile") -Destination (Join-Path $distRoot "app\src\$sourceFile")
}
foreach ($libraryFile in @('batch.mjs','batch-report.mjs','ispcr.mjs','job.mjs','primer3.mjs','recycle-bin.mjs','system-check.mjs','themes.mjs','ucsc.mjs','web-parameters.mjs')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "src\lib\$libraryFile") -Destination (Join-Path $distRoot "app\src\lib\$libraryFile")
}
foreach ($webFile in @('app.js','index.html','styles.css')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "src\web\$webFile") -Destination (Join-Path $distRoot "app\src\web\$webFile")
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'config\default.example.json') -Destination (Join-Path $distRoot 'app\config\default.json')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\Move-ToRecycleBin.ps1') -Destination (Join-Path $distRoot 'app\scripts\Move-ToRecycleBin.ps1')
foreach ($serverScript in @('provision-primer3.slurm','provision-ucsc.slurm','run-ispcr.slurm','run-primer3.slurm')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\server\$serverScript") -Destination (Join-Path $distRoot "app\scripts\server\$serverScript")
}

@{
    schemaVersion = 1
    dataRoot = $projectRoot
    port = 43110
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $distRoot 'settings.json') -Encoding UTF8

$manifest = Get-ChildItem -LiteralPath $distRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{
        path = $_.FullName.Substring($distRoot.Length + 1).Replace('\','/')
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $distRoot 'manifest.json') -Encoding UTF8

$zipPath = Join-Path $projectRoot 'dist\PrimerDesign-portable-win-x64.zip'
if (Test-Path -LiteralPath $zipPath) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $zipPath,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
        [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
    )
}
New-PortableZip -SourceRoot $distRoot -DestinationPath $zipPath
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zipPath.sha256" -Value "$zipHash  $(Split-Path $zipPath -Leaf)" -Encoding ASCII
Write-Host "Portable app: $distRoot"
Write-Host "ZIP: $zipPath"
Write-Host "SHA-256: $zipHash"
