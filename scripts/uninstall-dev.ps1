# 开发期卸载：把 dsh-user-sync 从真实 DSH profile 移除。
# 双击 uninstall-dev.cmd 即可运行；无需进入 DSH 界面。
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$pkgName = '@pandablessing/dsh-user-sync'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $profileDir "node_modules\$pkgName"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $linkPath) | Out-Null

if (-not (Test-Path -LiteralPath $pkgPath)) { throw "找不到 profile: $pkgPath" }

$raw = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
$json = $raw | ConvertFrom-Json
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$pkgPath.bak-uninstall-$stamp"
Copy-Item -LiteralPath $pkgPath -Destination $backupPath -Force

$changed = $false
if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) {
  $before = @($json.dsh.profile.bundles)
  $after = @($before | Where-Object { $_ -ne $pkgName })
  if ($after.Count -ne $before.Count) {
    $json.dsh.profile.bundles = $after
    $changed = $true
  }
}
if ($json.dependencies -and $json.dependencies.PSObject.Properties[$pkgName]) {
  $json.dependencies.PSObject.Properties.Remove($pkgName)
  $changed = $true
}

if ($changed) {
  $text = $json | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($pkgPath, $text, (New-Object System.Text.UTF8Encoding($false)))
  $bytes = [System.IO.File]::ReadAllBytes($pkgPath)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Copy-Item -LiteralPath $backupPath -Destination $pkgPath -Force
    throw '写入后检测到 BOM，已回滚'
  }
  Write-Host "已从 package.json 移除 $pkgName（备份: $backupPath）"
} else {
  Write-Host "package.json 中没有 $pkgName，无需改动"
}

if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    Remove-Item -LiteralPath $linkPath -Force
    Write-Host "已删除链接: $linkPath"
  } else {
    Write-Host "目标不是链接，跳过删除: $linkPath"
  }
}

Write-Host ''
Write-Host '完成。现在可以启动 DSH。'
