<#
  dsh-deepseek-web-relay —— 安装脚本（幂等，可反复运行）

  用法（在 PowerShell 里，cd 到插件目录后）：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome "C:\Users\<你>\.dsh"

  做的事：
    1. 在 node_modules 下建一个目录联接（Junction）指向本插件目录，
       这样 DSH 才能 require 到它；
    2. 把 "dsh-deepseek-web-relay" 加进 profile 的 package.json -> dsh.profile.bundles；
    3. 备份 package.json（带时间戳），改坏了可以还原；
    4. 跑一次 --dump-config 自检，确认插件真的会被加载。

  目录联接（Junction）不需要管理员权限，也不需要开发者模式。
#>

[CmdletBinding()]
param(
  # 默认取当前用户的 DSH Home（%USERPROFILE%\.dsh）。多实例（Launcher）用户请显式传 -DshHome。
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'tauri',
  [string]$PluginPath = ''
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-deepseek-web-relay'

# $PSScriptRoot 在 param() 默认值里不一定已赋值，这里兜底推导。
if (-not $PluginPath) { $PluginPath = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $PluginPath) { $PluginPath = (Get-Location).Path }

function Info($m) { Write-Host $m }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

Info "=== 安装 $PackageName ==="
Info "实例 Home : $DshHome"
Info "Profile   : $Profile"
Info "插件目录  : $PluginPath"
Info ""

# ── 0. 前置校验 ─────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $DshHome)) { Fail "实例 Home 不存在：$DshHome" }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath $ProfileDir)) { Fail "Profile 目录不存在：$ProfileDir（确认 profile 名字对不对）" }

foreach ($f in @('package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'tools\patch-bundles.cjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PluginPath $f))) { Fail "插件目录里缺少 $f" }
}
Ok "插件文件齐全"

$ProfilePkg = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $ProfilePkg)) { Fail "找不到 profile 的 package.json：$ProfilePkg" }

# ── 1. 决定 node_modules 落点 ───────────────────────────────────────────
# 两种实例布局，Node 的模块解析会从 profile 目录逐级向上找，两种都成立：
#   A) profile 自己就是 pnpm workspace -> <profile>\node_modules
#   B) 干净实例，依赖装在 profiles 根  -> <profiles>\node_modules
$ProfilesRoot = Join-Path $DshHome 'profiles'
if (Test-Path -LiteralPath (Join-Path $ProfileDir 'pnpm-workspace.yaml')) {
  $NodeModules = Join-Path $ProfileDir 'node_modules'
  Ok "布局 A（profile 自带 pnpm workspace）：$NodeModules"
} else {
  $NodeModules = Join-Path $ProfilesRoot 'node_modules'
  Ok "布局 B（干净实例，依赖在 profiles 根）：$NodeModules"
}
if (-not (Test-Path -LiteralPath $NodeModules)) {
  New-Item -ItemType Directory -Path $NodeModules -Force | Out-Null
  Ok "已创建 $NodeModules"
}

# ── 2. 备份 package.json ────────────────────────────────────────────────
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = "$ProfilePkg.bak-$Stamp"
Copy-Item -LiteralPath $ProfilePkg -Destination $Backup -Force
Ok "已备份 package.json -> $Backup"

# ── 3. 建目录联接 ───────────────────────────────────────────────────────
$Link = Join-Path $NodeModules $PackageName
$Target = (Resolve-Path -LiteralPath $PluginPath).Path

if (Test-Path -LiteralPath $Link) {
  $item = Get-Item -LiteralPath $Link -Force
  $cur = $null
  if ($item.LinkType) { $cur = ($item.Target | Select-Object -First 1) }
  $curResolved = $null
  if ($cur) { $curResolved = (Resolve-Path -LiteralPath $cur -ErrorAction SilentlyContinue).Path }
  if ($curResolved -eq $Target) {
    Ok "联接已存在且指向正确，跳过"
  } else {
    Warn "已存在但不是指向本插件的联接，先移除：$Link"
    # 只删联接本身，绝不递归删目标内容
    $item.Delete()
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
    Ok "已重建联接 -> $Target"
  }
} else {
  New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
  Ok "已建立联接 $Link -> $Target"
}

if (-not (Test-Path -LiteralPath (Join-Path $Link 'client.js'))) {
  Fail "联接建立后仍读不到 client.js，检查一下权限"
}
Ok "联接可用（能读到 client.js）"

# ── 4. 登记进 dsh.profile.bundles ───────────────────────────────────────
$patcher = Join-Path $PluginPath 'tools\patch-bundles.cjs'
$out = & node $patcher add $ProfilePkg $PackageName
if ($LASTEXITCODE -ne 0) { Fail "bundles 登记失败" }
Ok "bundles 登记：$($out[0])"
Info "    当前 bundles: $($out[1])"

# ── 5. 启动前自检 --dump-config ─────────────────────────────────────────
Info ""
Info "=== 启动前自检（--dump-config）==="
# 按「本机最可能出现 -> 越往后越兜底」的顺序找 dsh 的 bin.js。
$DshBinCandidates = @(
  (Join-Path $env:APPDATA 'dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'),
  (Join-Path $env:APPDATA 'io.github.baihejiangnan.dsh-launcher\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'),
  (Join-Path $env:LOCALAPPDATA 'deepseek-harness\node_modules\@deepseek-ai\dsh\lib\bin.js'),
  (Join-Path $env:SystemDrive 'dsh\node_modules\@deepseek-ai\dsh\lib\bin.js')
)
$DshBin = $DshBinCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $DshBin) {
  Warn "找不到 dsh 的 bin.js，跳过自检"
} else {
  Ok "使用 dsh：$DshBin"
  $env:DSH_HOME = $DshHome
  $cfg = (& node $DshBin --profile $Profile --dump-config 2>&1) -join "`n"
  if ($cfg -match [regex]::Escape($PackageName)) {
    Ok "dump-config 里已出现 $PackageName —— 插件会被加载"
  } else {
    Warn "dump-config 里没找到 $PackageName，请看下面的输出排查"
    ($cfg -split "`n" | Select-Object -Last 25) | ForEach-Object { Write-Host "    $_" }
  }
}

Info ""
Info "=== 装完了 ==="
Info "下一步：在 DSH 启动器里重启实例「$Profile」的窗口，然后按 Ctrl+Shift+R 硬刷新页面。"
Info "应急卸载：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome `"$DshHome`""
