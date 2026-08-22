<#
  gh-actions-live の native messaging host (Refs #9)。
  拡張 (chrome.runtime.sendNativeMessage) から呼ばれ、ローカルで update.ps1 を走らせる。
  拡張はディスクに書けないので、「更新」ボタンの実体はこれ。

  プロトコル: stdin/stdout に 4 バイト (ネイティブ byte order) の長さ + UTF-8 JSON。
    {cmd:"ping"}    -> {ok:true, pong:true, version:<ディスク上の拡張の版>}
    {cmd:"version"} -> {ok:true, version:...}
    {cmd:"update"}  -> update.ps1 を実行 -> {ok, updated:bool, from, to, output}
  MSI が HKCU\Software\Google\Chrome\NativeMessagingHosts\jp.ippoan.gh_actions_live に
  native-host-manifest.json の場所を登録する (Policies 配下ではないのでユーザー権限で書ける)。
#>
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtDir = Join-Path $Root 'extension'
$in  = [Console]::OpenStandardInput()
$out = [Console]::OpenStandardOutput()

function Read-Msg {
  $lenBuf = New-Object byte[] 4
  $n = $in.Read($lenBuf, 0, 4)
  if ($n -lt 4) { return $null }
  $len = [BitConverter]::ToInt32($lenBuf, 0)
  if ($len -le 0 -or $len -gt 1048576) { return $null }
  $buf = New-Object byte[] $len
  $read = 0
  while ($read -lt $len) {
    $r = $in.Read($buf, $read, $len - $read)
    if ($r -le 0) { return $null }
    $read += $r
  }
  return ([Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json)
}
function Write-Msg($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  $b = [Text.Encoding]::UTF8.GetBytes($json)
  $out.Write([BitConverter]::GetBytes([int]$b.Length), 0, 4)
  $out.Write($b, 0, $b.Length)
  $out.Flush()
}
function Disk-Version {
  $m = Join-Path $ExtDir 'manifest.json'
  if (Test-Path $m) { return (Get-Content $m -Raw | ConvertFrom-Json).version }
  return $null
}

while ($true) {
  $msg = Read-Msg
  if ($null -eq $msg) { break }
  try {
    switch ($msg.cmd) {
      'ping'    { Write-Msg @{ ok = $true; pong = $true; version = (Disk-Version) } }
      'version' { Write-Msg @{ ok = $true; version = (Disk-Version) } }
      'update'  {
        $from = Disk-Version
        $ps = (Get-Command powershell.exe).Source
        $output = & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'update.ps1') *>&1 | Out-String
        $code = $LASTEXITCODE
        $to = Disk-Version
        Write-Msg @{ ok = ($code -eq 0); updated = ($from -ne $to); from = $from; to = $to; output = $output.Trim() }
      }
      default   { Write-Msg @{ ok = $false; error = "unknown cmd: $($msg.cmd)" } }
    }
  } catch {
    Write-Msg @{ ok = $false; error = $_.Exception.Message }
  }
}
