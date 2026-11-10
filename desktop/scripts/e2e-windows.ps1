# Watches for console windows while the end-to-end test runs.
# Every 200 ms it lists visible top-level windows; any window that did not exist at the
# start and is a console (ConsoleWindowClass, Windows Terminal) or belongs to java, node,
# conhost, powershell, taskkill, tasklist or netstat is written to the output file.
# Stops when the stop file appears.
param([string]$OutFile, [string]$StopFile)

Add-Type -Namespace E2E -Name Win -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
'@

function Get-VisibleWindows {
    $list = [System.Collections.Generic.List[object]]::new()
    $cb = [E2E.Win+EnumProc] {
        param($hWnd, $lParam)
        if ([E2E.Win]::IsWindowVisible($hWnd)) {
            $cls = [System.Text.StringBuilder]::new(256)
            $title = [System.Text.StringBuilder]::new(256)
            [void][E2E.Win]::GetClassName($hWnd, $cls, 256)
            [void][E2E.Win]::GetWindowText($hWnd, $title, 256)
            $procId = [uint32]0
            [void][E2E.Win]::GetWindowThreadProcessId($hWnd, [ref]$procId)
            $list.Add([pscustomobject]@{ Handle = [int64]$hWnd; Class = $cls.ToString(); Title = $title.ToString(); Pid = $procId })
        }
        return $true
    }
    [void][E2E.Win]::EnumWindows($cb, [IntPtr]::Zero)
    return $list
}

$baseline = @{}
foreach ($w in Get-VisibleWindows) { $baseline[$w.Handle] = $true }
$suspicious = 'java', 'javaw', 'node', 'conhost', 'OpenConsole', 'powershell', 'pwsh', 'taskkill', 'tasklist', 'netstat', 'cmd', 'WindowsTerminal'
$found = @{}
$samples = 0
while (-not (Test-Path -LiteralPath $StopFile)) {
    $samples++
    foreach ($w in Get-VisibleWindows) {
        if ($baseline.ContainsKey($w.Handle) -or $found.ContainsKey($w.Handle)) { continue }
        $name = (Get-Process -Id $w.Pid -ErrorAction SilentlyContinue).ProcessName
        $isConsole = $w.Class -in @('ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'PseudoConsoleWindow')
        if ($isConsole -or $suspicious -contains $name) {
            $found[$w.Handle] = [pscustomobject]@{ Time = (Get-Date).ToString('HH:mm:ss.fff'); Class = $w.Class; Title = $w.Title; Process = $name; Pid = $w.Pid }
        }
    }
    Start-Sleep -Milliseconds 200
}
[pscustomobject]@{ samples = $samples; consoleWindows = @($found.Values) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutFile -Encoding utf8
