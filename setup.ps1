<#
.SYNOPSIS
  One-time setup of the Afro-channels playout stack on a fresh Windows PC.

.DESCRIPTION
  Run from the repo root after cloning:

    powershell -ExecutionPolicy Bypass -File .\setup.ps1

  It downloads CasparCG and MediaMTX (not kept in git), installs the
  dashboard's Node dependencies, creates amcp-dashboard\.env with a random
  session secret, and creates the database with an admin user you choose.

  Safe to re-run: every step skips work that is already done, and it never
  overwrites the config files tracked in git (casparcg.config, mediamtx.yml,
  the branding templates) or an existing .env / database.

.PARAMETER AutoStart
  Also register a Windows logon task that runs start-all.bat, so everything
  comes back by itself after a reboot. At logon rather than at boot, because
  CasparCG's screen output needs a desktop session.
#>
param([switch]$AutoStart)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = $PSScriptRoot
$Dashboard = Join-Path $Root 'amcp-dashboard'

$Releases = @(
  @{ Name = 'CasparCG Server 2.5.0'; Folder = 'casparcg-server-v2.5.0-stable-windows'; Exe = 'casparcg.exe'
     Url = 'https://github.com/CasparCG/server/releases/download/v2.5.0-stable/casparcg-server-v2.5.0-stable-windows.zip' },
  @{ Name = 'MediaMTX 1.20.1'; Folder = 'mediamtx_v1.20.1_windows_amd64'; Exe = 'mediamtx.exe'
     Url = 'https://github.com/bluenviron/mediamtx/releases/download/v1.20.1/mediamtx_v1.20.1_windows_amd64.zip' }
)

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }

# --- 1. Prerequisites --------------------------------------------------------
Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not installed. Install the LTS version from https://nodejs.org, open a new terminal, and re-run.'
}
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js $(node -v) is too old. Install the current LTS (20 or newer) and re-run." }
Ok "Node.js $(node -v)"
foreach ($tool in 'curl.exe', 'tar.exe', 'robocopy.exe') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found - this needs Windows 10 (1803) or newer." }
}
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { Ok 'NVIDIA driver found - the Health tab will show GPU load' }
else { Warn 'nvidia-smi not found - the Health tab will show GPU load as unavailable' }

# npm ci below replaces node_modules, which fails while the dashboard has it open.
if (Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue) {
  throw 'The dashboard is running (port 3005 is in use). Run stop-all.bat first, then re-run setup.'
}

# --- 2. CasparCG and MediaMTX ------------------------------------------------
Step 'Installing CasparCG and MediaMTX'
foreach ($r in $Releases) {
  $target = Join-Path $Root $r.Folder
  if (Test-Path (Join-Path $target $r.Exe)) { Ok "$($r.Name) already installed"; continue }

  $tmp = Join-Path $env:TEMP ("afro-setup-" + [IO.Path]::GetFileNameWithoutExtension($r.Exe))
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  $extract = Join-Path $tmp 'x'
  New-Item -ItemType Directory -Path $extract -Force | Out-Null
  $zip = Join-Path $tmp 'release.zip'

  # Retried with resume (-C -): a dropped connection partway through a
  # 234 MB download picks up where it stopped instead of starting over.
  Write-Host "   Downloading $($r.Name)..."
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    & curl.exe -L --fail --progress-bar -C - -o $zip $r.Url
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 6) { throw "Download failed after $attempt attempts: $($r.Url)" }
    Warn "Download interrupted (curl exit $LASTEXITCODE) - resuming, attempt $($attempt + 1) of 6"
    Start-Sleep -Seconds 3
  }
  & tar.exe -xf $zip -C $extract
  if ($LASTEXITCODE -ne 0) { throw "Could not extract $zip" }

  # Some release zips wrap everything in one top-level folder, some don't.
  $src = $extract
  $top = @(Get-ChildItem $extract)
  if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $src = $top[0].FullName }

  # /XC /XN /XO: copy only files the target doesn't have yet, so the release's
  # default casparcg.config / mediamtx.yml never replace the ones in git.
  & robocopy.exe $src $target /E /XC /XN /XO /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $($r.Name) failed (robocopy exit code $LASTEXITCODE)" }
  Remove-Item $tmp -Recurse -Force
  if (-not (Test-Path (Join-Path $target $r.Exe))) { throw "$($r.Exe) is missing from $target after extracting - check the release layout." }
  Ok "$($r.Name) installed"
}

# --- 3. Dashboard dependencies -----------------------------------------------
Step 'Installing dashboard dependencies (npm ci)'
Push-Location $Dashboard
try {
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed - see the output above.' }
} finally { Pop-Location }
New-Item -ItemType Directory -Path (Join-Path $Dashboard 'public\uploads') -Force | Out-Null
Ok 'Dependencies installed'

# --- 4. .env -----------------------------------------------------------------
Step 'Creating amcp-dashboard\.env'
$envFile = Join-Path $Dashboard '.env'
if (Test-Path $envFile) {
  Ok '.env already exists - left untouched'
} else {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  $content = (Get-Content (Join-Path $Dashboard '.env.example') -Raw) -replace '(?m)^SESSION_SECRET=.*$', "SESSION_SECRET=$secret"
  # WriteAllText = UTF-8 without a BOM; a BOM would hide the first key from dotenv.
  [IO.File]::WriteAllText($envFile, $content)
  Ok '.env created with a random SESSION_SECRET'
  Warn 'Cloud Streams settings (VM_HOST, VM_SSH_*, MEDIAMTX_*) still need filling in if you use that feature'
}

# --- 5. Database + admin user ------------------------------------------------
Step 'Creating the database'
$dbFile = Join-Path $Dashboard 'db\database.sqlite'
if (Test-Path $dbFile) {
  Ok 'Database already exists - left untouched'
} else {
  $user = Read-Host '   Admin username [admin]'
  if (-not $user) { $user = 'admin' }
  while ($true) {
    $p1 = Read-Host '   Admin password (8+ characters)' -AsSecureString
    $p2 = Read-Host '   Repeat the password' -AsSecureString
    $plain1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
    $plain2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
    if ($plain1 -ne $plain2) { Warn 'The passwords did not match - try again'; continue }
    if ($plain1.Length -lt 8) { Warn 'Use at least 8 characters - try again'; continue }
    break
  }
  $env:SEED_ADMIN_USER = $user
  $env:SEED_ADMIN_PASS = $plain1
  $env:SEED_SKIP_SAMPLE_CHANNEL = '1'
  Push-Location $Dashboard
  try {
    & node db/seed.js
    if ($LASTEXITCODE -ne 0) { throw 'Creating the database failed - see the output above.' }
  } finally {
    Pop-Location
    Remove-Item Env:SEED_ADMIN_USER, Env:SEED_ADMIN_PASS, Env:SEED_SKIP_SAMPLE_CHANNEL -ErrorAction SilentlyContinue
  }
  Ok "Database created with admin user `"$user`" and no channels"
}

# --- 6. Optional: start at logon ---------------------------------------------
if ($AutoStart) {
  Step 'Registering the logon task'
  try {
    $action = New-ScheduledTaskAction -Execute (Join-Path $Root 'start-all.bat') -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    Register-ScheduledTask -TaskName 'Afro-channels playout' -Action $action -Trigger $trigger -Force `
      -Description 'Starts the Afro-channels dashboard (which starts CasparCG and MediaMTX) at logon.' | Out-Null
    Ok "Task 'Afro-channels playout' runs start-all.bat when $env:USERNAME logs on"
  } catch {
    Warn "Could not register the task ($($_.Exception.Message)). Re-run this script from an Administrator PowerShell, or add start-all.bat to Task Scheduler by hand."
  }
}

Step 'Done'
Write-Host '   Start everything:  start-all.bat'
Write-Host '   Then open:         http://localhost:3005'
Write-Host '   Allow MediaMTX and Node.js through Windows Firewall when asked, so other machines can reach the HLS links (port 8888) and the dashboard (port 3005).'
