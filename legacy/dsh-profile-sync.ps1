<#
.SYNOPSIS
  DSH profile 配置导出/导入工具 —— 让同一 DSH 账号下的多台机器插件配置保持一致。

.DESCRIPTION
  DSH 官方没有账号级插件同步：插件是本机 profile 的「bundle 层 + 用户 patch 覆盖层」，
  包本体来自 npm registry 并由 pnpm 安装在本机。因此「一致」靠同步 profile 的声明文件实现。

  同步对象（默认 profile = desktop）：
    package.json         bundle 列表与第三方依赖声明
    cordis.patch.yml     用户层配置覆盖（模型、UI、provider 等）
    cordis.yml           profile 根（通常为空数组）
    pnpm-workspace.yaml  pnpm 安装器设置

  不同步：node_modules（平台相关，按声明重装）、sessions/storages（本机状态）、凭据文件。

.EXAMPLE
  # 1) 在源机器导出
  .\dsh-profile-sync.ps1 -Action Export

.EXAMPLE
  # 2) 在目标机器预览差异（不写盘）
  .\dsh-profile-sync.ps1 -Action Import -Package .\dsh-profile-desktop-20261014-1200.zip -WhatIf

.EXAMPLE
  # 3) 在目标机器应用
  .\dsh-profile-sync.ps1 -Action Import -Package .\dsh-profile-desktop-20261014-1200.zip

.NOTES
  本文件必须保存为 UTF-8 with BOM。Windows PowerShell 5.1 读取「无 BOM 的 UTF-8」.ps1 时
  会按系统 ANSI(GBK) 解码，中文注释与字符串随即乱码、引号被吞，直接报语法错误。
  重新编辑保存后请确认首三字节为 EF BB BF。
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Export', 'Import')][string]$Action,
  [string]$Profile = 'desktop',
  [string]$Package,
  [string]$OutDir = (Get-Location).Path,
  [string]$Root,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$SyncFiles = @('package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml')

function Get-DshRoot {
  if ($Root) {
    # 允许指向尚不存在的目录（新机器上 profile 可能还没建），导入时会按需创建
    if (Test-Path -LiteralPath $Root) { return (Resolve-Path -LiteralPath $Root).Path }
    return $Root
  }
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $env:USERPROFILE '.dsh')
}

function Get-FileHashHex([string]$Path) {
  # 归一化口径：删除所有 CR 字节(0x0D) 后算 SHA-256 —— 与 macOS/Linux 端脚本的
  # tr -d '\r' 逐字节等价，避免同一份配置因 CRLF/LF 差异被判成「有改动」而反复覆盖。
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $norm = New-Object System.Collections.Generic.List[byte]
  foreach ($b in $bytes) { if ($b -ne 0x0D) { $norm.Add($b) } }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash($norm.ToArray()) } finally { $sha.Dispose() }
  return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

# 导出时扫描疑似明文密钥（凭据本应放在 .credentials.yaml，不该进 profile）
function Test-SecretLeak([string]$Text) {
  $patterns = @(
    'sk-[A-Za-z0-9]{16,}',
    '(?i)api[_-]?key\s*:\s*["'']?[A-Za-z0-9\-_]{20,}',
    '(?i)token\s*:\s*["'']?[A-Za-z0-9\-_]{20,}',
    '(?i)secret\s*:\s*["'']?[A-Za-z0-9\-_]{20,}'
  )
  $found = @()
  foreach ($p in $patterns) { if ([regex]::IsMatch($Text, $p)) { $found += $p } }
  return $found
}

$dshRoot = Get-DshRoot
$profileDir = Join-Path $dshRoot "profiles\$Profile"

# ---------------------------------------------------------------- Export
if ($Action -eq 'Export') {
  if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "找不到 profile 目录: $profileDir"
  }

  $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("dshsync-export-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $staging -Force | Out-Null

  $entries = @()
  $warnings = @()
  foreach ($name in $SyncFiles) {
    $src = Join-Path $profileDir $name
    if (-not (Test-Path -LiteralPath $src)) { continue }
    Copy-Item -LiteralPath $src -Destination (Join-Path $staging $name) -Force
    $hash = Get-FileHashHex $src
    $entries += [ordered]@{ name = $name; sha256 = $hash; size = (Get-Item -LiteralPath $src).Length }
    if ($name -match '\.(yml|yaml|json)$') {
      $leaks = Test-SecretLeak (Get-Content -LiteralPath $src -Raw -Encoding UTF8)
      if ($leaks.Count -gt 0) { $warnings += "$name 疑似含明文密钥（模式: $($leaks -join '; ')）" }
    }
  }

  if ($entries.Count -eq 0) { throw "profile 目录下没有可同步的声明文件: $profileDir" }

  # 第三方插件依赖（本机为空则说明只用内置 bundle）
  $deps = @()
  $pkgPath = Join-Path $profileDir 'package.json'
  if (Test-Path -LiteralPath $pkgPath) {
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pkg.dependencies) {
      $deps = @($pkg.dependencies.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" })
    }
  }

  $manifest = [ordered]@{
    schemaVersion = 2
    hashMode      = 'lf'
    exportedAt    = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    machine       = $env:COMPUTERNAME
    dshHome       = $dshRoot
    profile       = $Profile
    bundles       = @()
    dependencies  = $deps
    files         = $entries
  }
  if (Test-Path -LiteralPath $pkgPath) {
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pkg.dsh.profile.bundles) { $manifest.bundles = @($pkg.dsh.profile.bundles) }
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $staging 'manifest.json') -Encoding UTF8

  if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $zipPath = Join-Path $OutDir "dsh-profile-$Profile-$stamp.zip"
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal
  Remove-Item -LiteralPath $staging -Recurse -Force -WhatIf:$false

  Write-Host "✅ 已导出: $zipPath" -ForegroundColor Green
  Write-Host "   profile : $Profile  ($dshRoot)"
  Write-Host "   文件    : $($entries.Count) 个 -> $((($entries | ForEach-Object { $_.name }) -join ', '))"
  Write-Host "   bundles : $(if ($manifest.bundles.Count) { $manifest.bundles -join ', ' } else { '(无)' })"
  Write-Host "   第三方插件: $(if ($deps.Count) { $deps -join ', ' } else { '(无，只用内置 bundle)' })"
  if ($warnings.Count -gt 0) {
    Write-Host "⚠️  敏感项提示:" -ForegroundColor Yellow
    $warnings | ForEach-Object { Write-Host "   - $_" -ForegroundColor Yellow }
  } else {
    Write-Host "   ✓ 未发现明文密钥"
  }
  Write-Host ""
  Write-Host "下一步：把该 zip 拷到目标机器，执行"
  Write-Host "  .\dsh-profile-sync.ps1 -Action Import -Package `"$([System.IO.Path]::GetFileName($zipPath))`" -WhatIf"
  return
}

# ---------------------------------------------------------------- Import
if ($Action -eq 'Import') {
  if (-not $Package) { throw "Import 需要 -Package <zip 路径>" }
  if (-not (Test-Path -LiteralPath $Package)) { throw "找不到配置包: $Package" }

  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("dshsync-import-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Expand-Archive -LiteralPath $Package -DestinationPath $work -Force
  $manifestPath = Join-Path $work 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "配置包缺少 manifest.json，无法校验" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

  Write-Host "配置包来源: $($manifest.machine) / profile=$($manifest.profile) / 导出时间 $($manifest.exportedAt)"
  Write-Host "目标 profile: $profileDir"
  Write-Host ""

  # 校验哈希（先验证，再落盘）
  $bad = @()
  foreach ($f in $manifest.files) {
    $p = Join-Path $work $f.name
    if (-not (Test-Path -LiteralPath $p)) { $bad += "$($f.name) 缺失"; continue }
    if ((Get-FileHashHex $p) -ne $f.sha256) { $bad += "$($f.name) 哈希不匹配" }
  }
  if ($bad.Count -gt 0) { throw "配置包校验失败: $($bad -join '; ')" }
  Write-Host "✅ 校验通过（$($manifest.files.Count) 个文件哈希一致）" -ForegroundColor Green

  # 差异对比
  $diffs = @(); $same = @()
  foreach ($f in $manifest.files) {
    $src = Join-Path $work $f.name
    $dst = Join-Path $profileDir $f.name
    if (-not (Test-Path -LiteralPath $dst)) { $diffs += "新增 $($f.name)" }
    elseif ((Get-FileHashHex $dst) -ne $f.sha256) { $diffs += "变更 $($f.name)" }
    else { $same += $f.name }
  }
  Write-Host ""
  if ($diffs.Count -eq 0) {
    Write-Host "✓ 目标机器已与配置包一致，无需改动（$($same -join ', ')）"
  } else {
    Write-Host "待应用改动:" -ForegroundColor Cyan
    $diffs | ForEach-Object { Write-Host "   - $_" }
  }
  Write-Host ""

  if ($manifest.dependencies.Count -gt 0) {
    Write-Host "⚠️  该配置包含第三方插件，应用后需在目标机器安装：" -ForegroundColor Yellow
    $manifest.dependencies | ForEach-Object { Write-Host "   dsh plugin --profile $Profile add $_" -ForegroundColor Yellow }
    Write-Host ""
  }

  if ($diffs.Count -eq 0 -and -not $Force) {
    Write-Host "未做任何写入。"
    Remove-Item -LiteralPath $work -Recurse -Force -WhatIf:$false
    return
  }

  if (-not $PSCmdlet.ShouldProcess($profileDir, "写入 $($diffs.Count) 个 profile 声明文件（自动备份现有内容）")) {
    Write-Host "（-WhatIf：未写入任何文件）"
    Remove-Item -LiteralPath $work -Recurse -Force -WhatIf:$false
    return
  }

  # 备份 -> 写入
  $backupDir = Join-Path $profileDir ("backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }

  # 只改写内容确有差异的文件：内容等价（含仅 CRLF/LF 换行差异）的不动，避免无谓改写与备份
  $written = 0
  foreach ($f in $manifest.files) {
    $name = $f.name
    if (-not $Force -and ($same -contains $name)) { continue }
    $dst = Join-Path $profileDir $name
    if (Test-Path -LiteralPath $dst) { Copy-Item -LiteralPath $dst -Destination (Join-Path $backupDir $name) -Force }
    Copy-Item -LiteralPath (Join-Path $work $name) -Destination $dst -Force
    $written++
  }
  Remove-Item -LiteralPath $work -Recurse -Force -WhatIf:$false

  Write-Host "✅ 已应用 $written 个文件到 $profileDir（另有 $($same.Count) 个内容等价已跳过）" -ForegroundColor Green
  Write-Host "   原文件备份: $backupDir"
  Write-Host ""
  Write-Host "下一步：彻底退出并重启 DSH（配置在启动时组装，热改不生效）。" -ForegroundColor Cyan
  return
}
