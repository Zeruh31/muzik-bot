# Shared by lavalink/baslat.ps1 and scripts/hepsini-baslat.ps1.
# Dot-source it:  . (Join-Path $PSScriptRoot 'dotenv.ps1')

# Parses .env text with the same rules as Node's built-in parser (process.loadEnvFile),
# which the bot uses, so both sides always see the same values:
#  - blank lines and lines starting with # are skipped, an optional "export " is ignored
#  - KEY = everything before the first "=", trimmed; lines without "=" are skipped
#  - a value starting with " ' or ` runs to the next same quote (it may span lines);
#    anything after the closing quote is ignored (e.g. a trailing # comment);
#    there are no escapes, only "\n" inside double quotes becomes a newline
#  - an unquoted value ends at the first #, then surrounding spaces are trimmed
# Returns an ordered dictionary KEY -> value.
function ConvertFrom-DotEnv([string]$Content) {
    $result = [ordered]@{}
    $text = $Content.TrimStart([char]0xFEFF) -replace "`r`n", "`n" -replace "`r", "`n"
    $pos = 0
    while ($pos -lt $text.Length) {
        $lineEnd = $text.IndexOf("`n", $pos)
        if ($lineEnd -lt 0) { $lineEnd = $text.Length }
        $line = $text.Substring($pos, $lineEnd - $pos)
        $next = $lineEnd + 1

        $trimmed = $line.Trim()
        if ($trimmed.StartsWith('export ')) { $trimmed = $trimmed.Substring(7).TrimStart() }
        $eq = $trimmed.IndexOf('=')
        if ($trimmed -eq '' -or $trimmed.StartsWith('#') -or $eq -lt 1) {
            $pos = $next
            continue
        }

        $key = $trimmed.Substring(0, $eq).Trim()
        $rest = $trimmed.Substring($eq + 1).TrimStart()
        $value = $null
        if ($rest.Length -gt 0 -and '"''`'.Contains($rest[0])) {
            $quote = $rest[0]
            $close = $rest.IndexOf($quote, 1)
            if ($close -gt 0) {
                $value = $rest.Substring(1, $close - 1)
            }
            else {
                # Multi-line value: look for the closing quote on the following lines.
                $startInText = $text.IndexOf($rest, $pos) + 1
                $closeInText = $text.IndexOf($quote, $startInText)
                if ($closeInText -ge 0) {
                    $value = $text.Substring($startInText, $closeInText - $startInText)
                    $after = $text.IndexOf("`n", $closeInText)
                    $next = if ($after -lt 0) { $text.Length } else { $after + 1 }
                }
            }
            if ($null -ne $value -and $quote -eq '"') { $value = $value.Replace('\n', "`n") }
        }
        if ($null -eq $value) {
            $hash = $rest.IndexOf('#')
            $value = if ($hash -ge 0) { $rest.Substring(0, $hash).Trim() } else { $rest.Trim() }
        }
        $result[$key] = $value
        $pos = $next
    }
    return $result
}

# Loads .env into the process environment. Variables already set win, the same rule the bot uses.
function Import-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $values = ConvertFrom-DotEnv ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8))
    foreach ($entry in $values.GetEnumerator()) {
        if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($entry.Key))) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value)
        }
    }
}

# Lavalink port from LAVALINK_PORT (same variable the bot uses), default 2333.
function Get-LavalinkPort {
    $raw = [Environment]::GetEnvironmentVariable('LAVALINK_PORT')
    if ([string]::IsNullOrWhiteSpace($raw)) { return 2333 }
    $port = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "LAVALINK_PORT 1 ile 65535 arasında bir sayı olmalı (şu an: $raw)."
    }
    return $port
}
