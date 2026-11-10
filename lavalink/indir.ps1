# Downloads Lavalink.jar from the official GitHub release and verifies its SHA-256.
# Usage: npm run lavalink:indir   (or: pwsh -File lavalink/indir.ps1)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Pinned release. The hash is the "digest" GitHub publishes for this release asset.
$Version = '4.2.2'
$ExpectedSha256 = '8cb801e591072c3689fafd71ccf571a95a4ead3cc35dfc045e157d763d89119a'
$Url = "https://github.com/lavalink-devs/Lavalink/releases/download/$Version/Lavalink.jar"

$JarPath = Join-Path $PSScriptRoot 'Lavalink.jar'
$TempPath = Join-Path $PSScriptRoot 'Lavalink.jar.indiriliyor'

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

if (Test-Path -LiteralPath $JarPath) {
    if ((Get-Sha256 $JarPath) -eq $ExpectedSha256) {
        Write-Host "Lavalink $Version zaten indirilmiş ve doğrulanmış: $JarPath" -ForegroundColor Green
        exit 0
    }
    Write-Host 'Mevcut Lavalink.jar farklı bir sürüm ya da bozuk; yeniden indiriliyor.' -ForegroundColor Yellow
}

Write-Host "Lavalink $Version indiriliyor (yaklaşık 100 MB)..."
Write-Host "Kaynak: $Url"
try {
    Invoke-WebRequest -Uri $Url -OutFile $TempPath -UseBasicParsing
}
catch {
    if (Test-Path -LiteralPath $TempPath) { Remove-Item -LiteralPath $TempPath -Force }
    Write-Host "HATA: İndirme başarısız oldu: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'İnternet bağlantınızı kontrol edip tekrar deneyin.' -ForegroundColor Red
    exit 1
}

$actual = Get-Sha256 $TempPath
if ($actual -ne $ExpectedSha256) {
    Remove-Item -LiteralPath $TempPath -Force
    Write-Host 'HATA: İndirilen dosyanın SHA-256 özeti beklenenle uyuşmuyor, dosya silindi.' -ForegroundColor Red
    Write-Host "Beklenen: $ExpectedSha256"
    Write-Host "Gelen:    $actual"
    exit 1
}

Move-Item -LiteralPath $TempPath -Destination $JarPath -Force
Write-Host "Tamam: Lavalink $Version indirildi ve doğrulandı -> $JarPath" -ForegroundColor Green
