# Opens Lavalink in its own window (unless it is already running), waits until it
# accepts connections, then starts the bot in this window.
# Usage: npm run hepsi

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$LavalinkScript = Join-Path $ProjectDir 'lavalink\baslat.ps1'
. (Join-Path $ProjectDir 'lavalink\dotenv.ps1')
. (Join-Path $ProjectDir 'lavalink\process-args.ps1')
Import-DotEnv (Join-Path $ProjectDir '.env')
try {
    $Port = Get-LavalinkPort
}
catch {
    Write-Host "HATA: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

function Test-LavalinkPort {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    try {
        return $tcp.ConnectAsync('127.0.0.1', $Port).Wait(1000) -and $tcp.Connected
    }
    catch {
        return $false
    }
    finally {
        $tcp.Dispose()
    }
}

if (Test-LavalinkPort) {
    Write-Host 'Lavalink zaten açık.' -ForegroundColor Green
}
else {
    Write-Host 'Lavalink yeni bir pencerede açılıyor...' -ForegroundColor Cyan
    $shell = (Get-Process -Id $PID).Path
    # One pre-quoted string: an -ArgumentList array would split the "Müzik Bot" path at the space.
    Start-Process -FilePath $shell -WorkingDirectory $ProjectDir -ArgumentList (Get-LavalinkWindowCommandLine $LavalinkScript)

    $deadline = (Get-Date).AddSeconds(120)
    while (-not (Test-LavalinkPort)) {
        if ((Get-Date) -gt $deadline) {
            Write-Host 'HATA: Lavalink 2 dakikada açılmadı. Lavalink penceresindeki hata mesajına bakın.' -ForegroundColor Red
            exit 1
        }
        Start-Sleep -Seconds 2
    }
    Write-Host 'Lavalink hazır.' -ForegroundColor Green
}

Set-Location -LiteralPath $ProjectDir
& node (Join-Path $ProjectDir 'src\index.js')
exit $LASTEXITCODE
