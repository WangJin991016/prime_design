$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appUrl = 'http://127.0.0.1:43110'
$healthUrl = "$appUrl/api/health"
$serviceId = 'prime-design-local-v1'

# Some launch hosts expose both Path and PATH in the same native environment
# block. Windows treats them as one variable, but Start-Process rejects the
# duplicate keys before creating a child. Preserve the effective value while
# normalizing this launcher process to one canonical entry.
$processPath = [Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::Process)
if ($processPath) {
    [Environment]::SetEnvironmentVariable('PATH', $null, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('Path', $null, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('Path', $processPath, [EnvironmentVariableTarget]::Process)
}

function Get-PrimerDesignHealth {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
        if ($response.StatusCode -ne 200) { return $null }
        $health = $response.Content | ConvertFrom-Json
        if ($health.serviceId -ne $serviceId) { return $null }
        return $health
    }
    catch {
        return $null
    }
}

function Open-PrimerDesignPage {
    Start-Process $appUrl | Out-Null
}

function Show-StartupError([string]$message) {
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            $message,
            'Primer Design Startup Error',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error
        ) | Out-Null
    }
    catch {
        # The launcher is intentionally hidden; the log paths in $message remain the fallback evidence.
    }
}

if (Get-PrimerDesignHealth) {
    Open-PrimerDesignPage
    exit 0
}

try {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
catch {
    Show-StartupError 'node.exe was not found. Install Node.js 22 or newer, then start the app again.'
    exit 1
}

$logDirectory = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutLog = Join-Path $logDirectory "app-$stamp.out.log"
$stderrLog = Join-Path $logDirectory "app-$stamp.err.log"

try {
    $process = Start-Process `
        -FilePath $nodePath `
        -ArgumentList @('src\app.mjs') `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Get-PrimerDesignHealth) {
            Open-PrimerDesignPage
            exit 0
        }
        $process.Refresh()
        if ($process.HasExited) { break }
    }

    $process.Refresh()
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
    Show-StartupError "The local service did not start within 15 seconds. Port 43110 may be in use.`n`nStandard output: $stdoutLog`nError log: $stderrLog"
    exit 1
}
catch {
    Show-StartupError "The local service failed to start: $($_.Exception.Message)`n`nStandard output: $stdoutLog`nError log: $stderrLog"
    exit 1
}
