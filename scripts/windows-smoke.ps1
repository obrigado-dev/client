# The Windows build, driven the way Claude Code drives a status line (A46).
#
#   pwsh scripts/windows-smoke.ps1 -Binary dist/binaries/obrigado-windows-x64.exe
#
# Installed into the settings of a scratch profile, with the program off PATH as install.ps1
# leaves it, then rendered from the command it wrote through each shell Claude Code uses: Git
# Bash, Windows PowerShell and PowerShell 7, each handed the session's JSON on stdin. A render
# names its session's state file after the `session_id` it read, so that file proves the shell
# found the program and passed the JSON through. Then uninstalled. CI's `windows` job runs it.
param([Parameter(Mandatory = $true)] [string]$Binary)
$ErrorActionPreference = 'Stop'
$failures = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "ok   $name" } else { Write-Host "FAIL $name`n$detail"; $script:failures++ }
}

$profileDir = Join-Path ([IO.Path]::GetTempPath()) "obrigado-smoke-$([guid]::NewGuid())"
$bin = Join-Path $profileDir '.local\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$exe = Join-Path $bin 'obrigado.exe'
Copy-Item -LiteralPath $Binary -Destination $exe

# A home of its own, a server that is not there, and no CI: under CI the renderer stays quiet by
# design, and these are the variables it reads that from (`CI_VARIABLES` in api.ts).
$env:USERPROFILE = $profileDir
$env:HOME = $profileDir
$env:OBRIGADO_API_ORIGIN = 'http://127.0.0.1:9'
foreach ($name in 'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'GITHUB_ACTIONS', 'TF_BUILD') {
    Remove-Item "env:$name" -ErrorAction SilentlyContinue
}
# Windows Terminal's mark, which a person's session would carry and a runner's does not.
$env:WT_SESSION = 'windows-smoke'

$version = (& $exe version | Out-String).Trim()
Check 'reports its version' ($version -match '^\d+\.\d+\.\d+$') $version

$said = & $exe install --agent claude-code --no-input 2>&1 | Out-String
& $exe config auto_update false | Out-Null
$settingsPath = Join-Path $profileDir '.claude\settings.json'
$command = (Get-Content -Raw $settingsPath | ConvertFrom-Json).statusLine.command
Check 'writes a command from home, in forward slashes' ($command -eq '~/.local/bin/obrigado.exe statusline --agent claude-code') "$command`n$said"

function SessionFile([string]$id) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $hex = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($id)) | ForEach-Object { $_.ToString('x2') })
    Join-Path $profileDir ".obrigado\sessions\claude-code\$($hex.Substring(0, 32)).json"
}

$shells = [ordered]@{
    'Git Bash' = @('C:\Program Files\Git\bin\bash.exe', '-c')
    'Windows PowerShell' = @('powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command')
    'PowerShell 7' = @('pwsh.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command')
}
foreach ($shell in $shells.Keys) {
    $id = "smoke-$($shell -replace ' ', '-')"
    $payload = "{`"session_id`":`"$id`",`"workspace`":{`"current_dir`":`"C:/smoke`"},`"version`":`"2.1.302`"}"
    $argv = $shells[$shell]
    $out = $payload | & $argv[0] @($argv[1..($argv.Length - 1)] + $command) 2>&1 | Out-String
    $code = $LASTEXITCODE
    Check "renders through $shell" ($code -eq 0) "exit $code`n$out"
    Check "  with the session's JSON on stdin" (Test-Path (SessionFile $id)) $out
}

$said = & $exe uninstall --agent claude-code 2>&1 | Out-String
$settings = Get-Content -Raw $settingsPath | ConvertFrom-Json
Check 'uninstall takes the line back out' ($null -eq $settings.PSObject.Properties['statusLine']) $said

Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "$failures failed"
if ($failures -gt 0) { exit 1 }
