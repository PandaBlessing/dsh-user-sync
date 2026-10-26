# 开发期安装：把当前仓库 link 进真实 DSH profile。
# - 幂等：已安装则只校验，不改文件
# - 改 package.json 前自动备份到同目录 .bak-<stamp>
# - 失败不留下半改状态；回滚命令在最后打印
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'desktop',
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$pkgName = '@pandablessing/dsh-user-sync'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $profileDir "node_modules\$pkgName"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $linkPath) | Out-Null

if (-not (Test-Path -LiteralPath $pkgPath)) { throw "找不到 profile: $pkgPath" }
if (-not (Test-Path -LiteralPath (Join-Path $Repo 'package.json'))) { throw "仓库路径无效: $Repo" }

$dry = $DryRun.IsPresent
$raw = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8
$json = $raw | ConvertFrom-Json
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$pkgPath.bak-$stamp"

$needDependency = -not $json.dependencies -or -not $json.dependencies.PSObject.Properties[$pkgName]
$bundles = @()
if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
$needBundle = $bundles -notcontains $pkgName

if ($dry) {
  Write-Host "[DryRun] dependency 需要添加: $needDependency"
  Write-Host "[DryRun] bundles 需要添加: $needBundle"
  Write-Host "[DryRun] 将创建链接: $linkPath -> $Repo"
  return
}

if (-not $needDependency -and -not $needBundle -and (Test-Path -LiteralPath $linkPath)) {
  Write-Host "已安装且无需改动: $linkPath"
  return
}

# 1) 链接（先删旧链接，避免目标漂移）
if (Test-Path -LiteralPath $linkPath) {
  $existing = Get-Item -LiteralPath $linkPath -Force
  if ($existing.LinkType -ne 'Junction' -and $existing.LinkType -ne 'SymbolicLink') {
    throw "目标已存在且不是链接，拒绝覆盖: $linkPath"
  }
  Remove-Item -LiteralPath $linkPath -Force
}
New-Item -ItemType Junction -Path $linkPath -Target $Repo | Out-Null
Write-Host "已创建链接: $linkPath -> $Repo"

# 2) 备份后改 package.json
Copy-Item -LiteralPath $pkgPath -Destination $backupPath -Force
Write-Host "已备份: $backupPath"

$json.dependencies = if ($json.dependencies) { $json.dependencies } else { [pscustomobject]@{} }
$json.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue "link:$($Repo.Replace('\','/'))" -Force
if (-not $json.dsh) { $json.dsh = [pscustomobject]@{} }
if (-not $json.dsh.profile) { $json.dsh.profile = [pscustomobject]@{} }
$json.dsh.profile.bundles = @($bundles + $pkgName)

# 3) 写回：必须是 UTF-8 **无 BOM**。
# 宿主用 JSON.parse 读 profile/package.json，BOM 会直接抛错并让 DSH 无法启动。
$text = $json | ConvertTo-Json -Depth 10
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($pkgPath, $text, $utf8NoBom)
} catch {
  Copy-Item -LiteralPath $backupPath -Destination $pkgPath -Force
  throw "写入失败，已回滚 package.json: $($_.Exception.Message)"
}

# 4) 写后自检：首字节非 BOM、JSON 可解析、bundles 含目标包；任一失败立即回滚。
$bytes = [System.IO.File]::ReadAllBytes($pkgPath)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  Copy-Item -LiteralPath $backupPath -Destination $pkgPath -Force
  throw "写入后检测到 UTF-8 BOM，已回滚（宿主 JSON.parse 会因此启动失败）"
}
$check = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($check.dsh.profile.bundles) -notcontains $pkgName) {
  Copy-Item -LiteralPath $backupPath -Destination $pkgPath -Force
  throw "写入后校验失败（bundles 缺 $pkgName），已回滚"
}

Write-Host "已更新: $pkgPath（UTF-8 无 BOM，自检通过）"

Write-Host ""
Write-Host "下一步：完全退出 DSH 并重新启动，设置页应出现「用户同步」。"
Write-Host "回滚命令："
Write-Host "  Copy-Item -LiteralPath '$backupPath' -Destination '$pkgPath' -Force"
Write-Host "  Remove-Item -LiteralPath '$linkPath' -Force"
