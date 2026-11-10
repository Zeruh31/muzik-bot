'use strict';

// Windows process helpers. Every helper runs hidden (windowsHide) so no console window
// ever flashes on screen.

const { spawn, spawnSync, execFile } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKKILL = path.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');
const TASKLIST = path.join(SYSTEM_ROOT, 'System32', 'tasklist.exe');
const NETSTAT = path.join(SYSTEM_ROOT, 'System32', 'NETSTAT.EXE');

function assertPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`Geçersiz PID: ${pid}`);
}

/** Runs a program hidden and returns { code, stdout, stderr } (decoded as latin1; callers only read ASCII). */
function run(file, args, { timeoutMs = 15_000, encoding = 'latin1' } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, encoding, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, options) {
  return run(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
    options,
  );
}

/**
 * PowerShell script that sends Ctrl+C to the console of one process, like pressing Ctrl+C
 * in its window. Node then runs its SIGINT handler and Java its shutdown hooks, so both
 * close cleanly. It refuses (exit 3) when the console is shared with any other process,
 * so it can never interrupt something else.
 */
function ctrlCScript(pid) {
  assertPid(pid);
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace MuzikBot -Name ConsoleApi -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
[DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList(uint[] list, uint count);
'@
$target = ${pid}
[void][MuzikBot.ConsoleApi]::FreeConsole()
if (-not [MuzikBot.ConsoleApi]::AttachConsole($target)) { exit 2 }
$list = New-Object 'uint32[]' 64
$count = [MuzikBot.ConsoleApi]::GetConsoleProcessList($list, 64)
$others = @($list | Select-Object -First $count | Where-Object { $_ -ne $target -and $_ -ne $PID })
if ($others.Count -gt 0) { [void][MuzikBot.ConsoleApi]::FreeConsole(); exit 3 }
[void][MuzikBot.ConsoleApi]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
if (-not [MuzikBot.ConsoleApi]::GenerateConsoleCtrlEvent(0, 0)) { exit 4 }
Start-Sleep -Milliseconds 300
[void][MuzikBot.ConsoleApi]::FreeConsole()
exit 0
`;
}

/** Asks a console process to stop as if Ctrl+C was pressed. Resolves true when the signal was sent. */
async function sendCtrlC(pid) {
  const result = await runPowerShell(ctrlCScript(pid), { timeoutMs: 20_000 });
  return result.code === 0;
}

/** Force-kills a process and all of its children. */
async function killTree(pid) {
  assertPid(pid);
  await run(TASKKILL, ['/PID', String(pid), '/T', '/F']);
}

/** Synchronous killTree for crash paths where nothing async can run any more. */
function killTreeSync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
  } catch {
    // best effort
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Parses `tasklist /FO CSV /NH` output: "java.exe","31212","Console","1","364.124 K". */
function parseTasklistCsv(text) {
  const match = /^"([^"]+)","(\d+)"/m.exec(String(text ?? ''));
  return match ? { name: match[1], pid: Number(match[2]) } : null;
}

/** Image name of a running process (e.g. "java.exe"), or null. */
async function processName(pid) {
  assertPid(pid);
  const result = await run(TASKLIST, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  return parseTasklistCsv(result.stdout)?.name ?? null;
}

/** Full command line of a running process, or null. */
async function processCommandLine(pid) {
  assertPid(pid);
  const result = await runPowerShell(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $p.CommandLine }`,
    { encoding: 'utf8' },
  );
  const text = result.stdout.trim();
  return text || null;
}

/** Parses the JSON from listProcesses' PowerShell query (one object or an array). */
function parseProcessJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name,
    cmd: String(p.CommandLine ?? ''),
  }));
}

/** Running node.exe / java.exe / javaw.exe processes with their command lines. */
async function listProcesses() {
  const result = await runPowerShell(
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='java.exe' or Name='javaw.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress",
    { encoding: 'utf8', timeoutMs: 30_000 },
  );
  try {
    return parseProcessJson(result.stdout);
  } catch {
    return [];
  }
}

/**
 * Parses `netstat -ano -p TCP` and returns PIDs listening on `port`.
 * The state column is localized on some Windows languages, so a listening socket is
 * recognised by its empty foreign address (0.0.0.0:0 or [::]:0).
 */
function parseNetstatListeners(text, port) {
  const pids = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+(0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (match && Number(match[2]) === port) pids.add(Number(match[4]));
  }
  return [...pids];
}

async function findListeningPids(port) {
  const result = await run(NETSTAT, ['-ano', '-p', 'TCP']);
  return parseNetstatListeners(result.stdout, port);
}

/** True when something accepts TCP connections on host:port. */
function isPortInUse(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Spawns a program hidden and collects its output (used for the bot's helper scripts). */
function runCollect(command, args, { cwd, env, timeoutMs = 120_000, onLine } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout, stderr: error.message });
      return;
    }
    const timer = setTimeout(() => {
      if (child.pid) killTreeSync(child.pid);
    }, timeoutMs);
    const collect = (stream, append) => {
      stream.setEncoding('utf8');
      let pending = '';
      stream.on('data', (chunk) => {
        append(chunk);
        if (!onLine) return;
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) onLine(line);
      });
      stream.on('end', () => {
        if (onLine && pending) onLine(pending);
      });
    };
    collect(child.stdout, (c) => (stdout += c));
    collect(child.stderr, (c) => (stderr += c));
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.once('error', (error) => {
      stderr += error.message;
      finish(-1);
    });
    child.once('close', (code) => finish(code ?? -1));
  });
}

module.exports = {
  sendCtrlC,
  ctrlCScript,
  killTree,
  killTreeSync,
  isAlive,
  processName,
  processCommandLine,
  listProcesses,
  parseProcessJson,
  parseTasklistCsv,
  parseNetstatListeners,
  findListeningPids,
  isPortInUse,
  runCollect,
  run,
  runPowerShell,
};
