# 真实 DSH 冒烟：确认插件路由已注册（发布/重启后运行）。
# 判定：/api/dsh-user-sync/status 返回 200 或 401 = 路由存在；404 = 未注册。
param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

if ($Port -eq 0) {
  $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -match 'DeepSeek') { $_ }
    } |
    Sort-Object LocalPort -Unique |
    Select-Object -First 1
  if (-not $listener) { throw '找不到 DSH 监听端口（DSH 未运行？）' }
  $Port = $listener.LocalPort
}

Write-Host "DSH 端口: $Port"
$base = "http://127.0.0.1:$Port"
$failed = $false

function Check-Route([string]$path) {
  $url = "$base$path"
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
    Write-Host ("{0} -> {1}" -f $path, $response.StatusCode)
    return $response.StatusCode
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401 -or $code -eq 403) {
      Write-Host ("{0} -> {1}（路由存在，需鉴权）" -f $path, $code)
      return $code
    }
    if ($code -eq 404) {
      Write-Warning ("{0} -> 404（路由未注册）" -f $path)
      return 404
    }
    throw
  }
}

foreach ($path in @('/api/dsh-user-sync/status', '/api/dsh-user-sync/scan')) {
  $code = Check-Route $path
  if ($code -eq 404) { $failed = $true }
}

if ($failed) {
  Write-Warning '冒烟失败：插件路由未注册。检查 lib/index.js 的 ctx.inject([连接服务]) 与插件是否加载。'
  exit 1
}

Write-Host '冒烟通过：插件路由已注册。'
