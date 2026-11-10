# Starts Lavalink with the settings from the project's .env file.
# Usage: npm run lavalink   (or: pwsh -File lavalink/baslat.ps1)

$ErrorActionPreference = 'Stop'

$LavalinkDir = $PSScriptRoot
$ProjectDir = Split-Path -Parent $LavalinkDir
$EnvFile = Join-Path $ProjectDir '.env'
$JarPath = Join-Path $LavalinkDir 'Lavalink.jar'

function Stop-WithError([string]$Message) {
    Write-Host "HATA: $Message" -ForegroundColor Red
    exit 1
}

. (Join-Path $PSScriptRoot 'dotenv.ps1')

# 1) Java
$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if (-not $javaCmd) {
    Stop-WithError 'Java bulunamadı. Lavalink için Java 17 veya daha yenisi gerekir (önerilen: Java 21). README.md içindeki "1. Gerekenler" adımına bakın.'
}
$javaVersionLine = (& java -version 2>&1 | Select-Object -First 1 | Out-String).Trim()
if ($javaVersionLine -match 'version "(\d+)') {
    $javaMajor = [int]$Matches[1]
    if ($javaMajor -lt 17) {
        Stop-WithError "Java sürümünüz çok eski ($javaVersionLine). Java 17 veya daha yenisi gerekir."
    }
}

# 2) Lavalink.jar
if (-not (Test-Path -LiteralPath $JarPath)) {
    Stop-WithError 'lavalink\Lavalink.jar yok. Önce "npm run lavalink:indir" komutunu çalıştırın.'
}

# 3) Settings from .env
if (-not (Test-Path -LiteralPath $EnvFile)) {
    Write-Host 'Uyarı: .env dosyası bulunamadı. .env.example dosyasını .env adıyla kopyalayıp doldurun.' -ForegroundColor Yellow
}
Import-DotEnv $EnvFile

if ([string]::IsNullOrWhiteSpace($env:LAVALINK_PASSWORD)) {
    Stop-WithError '.env dosyasında LAVALINK_PASSWORD boş. Kendinize bir şifre belirleyip yazın (bot da aynı şifreyi kullanır).'
}

if (-not [string]::IsNullOrWhiteSpace($env:SPOTIFY_CLIENT_ID) -and -not [string]::IsNullOrWhiteSpace($env:SPOTIFY_CLIENT_SECRET)) {
    $env:SPOTIFY_ENABLED = 'true'
    Write-Host 'Spotify desteği: AÇIK' -ForegroundColor Green
}
else {
    $env:SPOTIFY_ENABLED = 'false'
    Write-Host 'Spotify desteği: KAPALI (.env içinde SPOTIFY_CLIENT_ID ve SPOTIFY_CLIENT_SECRET boş)' -ForegroundColor Yellow
}

if ([string]::IsNullOrWhiteSpace($env:YOUTUBE_OAUTH_REFRESH_TOKEN)) {
    Write-Host ''
    Write-Host 'YouTube girişi henüz yapılmamış. Birazdan konsolda "google.com/device" adresi ve bir kod görünecek.' -ForegroundColor Yellow
    Write-Host 'O adrese gidip kodu girin ve YAN (önemsiz) bir Google hesabıyla giriş yapın. Ana hesabınızı KULLANMAYIN.' -ForegroundColor Yellow
    Write-Host 'Giriş bitince yeni bir terminalde "npm run youtube-token" çalıştırın; token .env dosyasına kaydedilir.' -ForegroundColor Yellow
    Write-Host ''
}

$heap = if ([string]::IsNullOrWhiteSpace($env:LAVALINK_JAVA_MEMORY)) { '512M' } else { $env:LAVALINK_JAVA_MEMORY }

try {
    # application.yml reads the same variable: port: ${LAVALINK_PORT:2333}
    $env:LAVALINK_PORT = [string](Get-LavalinkPort)
}
catch {
    Stop-WithError $_.Exception.Message
}

Write-Host "Lavalink başlatılıyor (yalnızca 127.0.0.1:$($env:LAVALINK_PORT)). Kapatmak için bu pencerede Ctrl+C." -ForegroundColor Cyan
Push-Location -LiteralPath $LavalinkDir
try {
    & java "-Xmx$heap" -jar $JarPath
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $code
