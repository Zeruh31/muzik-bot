# Builds Windows command lines for Start-Process.
#
# Start-Process -ArgumentList joins its array with plain spaces and does NOT quote items, so a
# path such as "D:\Botlar\Müzik Bot\lavalink\baslat.ps1" arrives as two arguments and the
# new window tries to run "D:\Botlar\Müzik". These helpers quote each argument with the
# rules Windows programs use to split a command line (CommandLineToArgvW / .NET), and the
# result is passed to Start-Process as ONE string.
# Dot-source it:  . (Join-Path $PSScriptRoot 'process-args.ps1')

function ConvertTo-CommandLineArgument([string]$Value) {
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $backslash = [char]92
    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $pending = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq $backslash) {
            $pending++
            continue
        }
        if ($ch -eq '"') {
            # Backslashes before a quote are doubled, and the quote itself is escaped.
            [void]$builder.Append($backslash, 2 * $pending + 1)
        }
        elseif ($pending -gt 0) {
            [void]$builder.Append($backslash, $pending)
        }
        [void]$builder.Append($ch)
        $pending = 0
    }
    # Backslashes right before the closing quote are doubled too ("C:\dir\" -> "C:\dir\\").
    if ($pending -gt 0) { [void]$builder.Append($backslash, 2 * $pending) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Join-CommandLine([string[]]$Arguments) {
    return ($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' '
}

# Arguments for the separate PowerShell window that runs lavalink/baslat.ps1.
function Get-LavalinkWindowCommandLine([string]$ScriptPath) {
    return Join-CommandLine @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', $ScriptPath)
}
