<#
  gh-actions-live の自動更新スクリプト (Refs #9)。

  Chrome は Web Store 外の拡張の update_url を相手にしないので、自動更新は自前で 2 段:
    ① このスクリプトが GitHub Release を見て、新しければ zip を落として extension\ を上書きする
    ② 拡張が「ディスク上の manifest.json」と「動いている版」を比べ、違えば chrome.runtime.reload()

  ①が本ファイル。MSI がタスク スケジューラに登録する (ログオン時 + 1 時間ごと、ユーザー権限)。

  使い方:
    update.ps1               今すぐ 1 回チェックして更新
    update.ps1 -Register     タスク スケジューラに登録 (MSI の install が呼ぶ)
    update.ps1 -Unregister   登録解除 (MSI の uninstall が呼ぶ)
#>
[CmdletBinding()]
param(
  [switch]$Register,
  [switch]$Unregister,
  [string]$Repo = 'ippoan/gh-actions-live'
)
$ErrorActionPreference = 'Stop'
$TaskName = 'gh-actions-live updater'
$Root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtDir   = Join-Path $Root 'extension'
$LogFile  = Join-Path $Root 'update.log'
$Base     = "https://github.com/$Repo/releases/latest/download"

function Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

if ($Register) {
  $ps = (Get-Command powershell.exe).Source
  $action  = New-ScheduledTaskAction -Execute $ps `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  $logon   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $hourly  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
               -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
               -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $hourly) `
    -Settings $settings -RunLevel Limited -Force | Out-Null
  Log "registered scheduled task '$TaskName' (logon + hourly) -> $($MyInvocation.MyCommand.Path)"
  exit 0
}

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Log "unregistered scheduled task '$TaskName'"
  exit 0
}

# ---- 更新チェック ----
try {
  $local = '0.0.0'
  $manifest = Join-Path $ExtDir 'manifest.json'
  if (Test-Path $manifest) { $local = (Get-Content $manifest -Raw | ConvertFrom-Json).version }

  [xml]$xml = (Invoke-WebRequest -UseBasicParsing -Uri "$Base/update.xml" -TimeoutSec 30).Content
  $remote = $xml.gupdate.app.updatecheck.version
  if (-not $remote) { throw "update.xml から version が読めない" }

  if ([version]$remote -le [version]$local) { Log "up to date ($local)"; exit 0 }
  Log "update available: $local -> $remote"

  $tmp = Join-Path $env:TEMP "gh-actions-live-update-$remote"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'extension.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/gh-actions-live-extension.zip" -OutFile $zip -TimeoutSec 120
  $want = ((Invoke-WebRequest -UseBasicParsing -Uri "$Base/gh-actions-live-extension.zip.sha256" -TimeoutSec 30).Content).Trim().ToLower()
  $have = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $have) { throw "sha256 mismatch: want $want have $have" }

  $stage = Join-Path $tmp 'extension'
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  $stagedVer = (Get-Content (Join-Path $stage 'manifest.json') -Raw | ConvertFrom-Json).version
  if ($stagedVer -ne $remote) { throw "zip の manifest version ($stagedVer) が update.xml ($remote) と違う" }

  # 上書き。消えたファイルも消したいので一度退避してから差し替える
  $bak = "$ExtDir.bak"
  if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
  if (Test-Path $ExtDir) { Move-Item $ExtDir $bak }
  try {
    Move-Item $stage $ExtDir
    if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
  } catch {
    if (-not (Test-Path $ExtDir) -and (Test-Path $bak)) { Move-Item $bak $ExtDir }
    throw
  }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Log "updated to $remote (extension will reload itself)"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
