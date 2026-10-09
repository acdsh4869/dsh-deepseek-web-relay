<#
  dsh-deepseek-web-relay —— 卸载 / 紧急禁用脚本（幂等）

  用法（cd 到插件目录后）：
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome "D:\dshl"

  做两件事，做完重启实例即彻底不加载：
    1. 从 profile package.json -> dsh.profile.bundles 里移除本插件；
    2. 删掉 node_modules 下的目录联接（只删联接，不动插件源码目录）。

  不碰 DSH 的任何原有代码，也不碰别的插件。
#>

[CmdletBinding()]
param(
  [string]$DshHome = 'D:\dshl2',
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

Info "=== 卸载 / 禁用 $PackageName ==="
Info "实例 Home : $DshHome"
Info "Profile   : $Profile"
Info ""

$ProfileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath $ProfileDir)) { Warn "Profile 目录不存在：$ProfileDir"; exit 0 }

# ── 1. 从 bundles 里摘掉 ────────────────────────────────────────────────
$ProfilePkg = Join-Path $ProfileDir 'package.json'
if (Test-Path -LiteralPath $ProfilePkg) {
  $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item -LiteralPath $ProfilePkg -Destination "$ProfilePkg.bak-$Stamp" -Force
  Ok "已备份 package.json -> $ProfilePkg.bak-$Stamp"

  $patcher = Join-Path $PluginPath 'tools\patch-bundles.cjs'
  if (Test-Path -LiteralPath $patcher) {
    $out = & node $patcher remove $ProfilePkg $PackageName
    Ok "bundles 处理：$($out[0])"
    Info "    当前 bundles: $($out[1])"
  } else {
    Warn "找不到 tools\patch-bundles.cjs，请手工从 dsh.profile.bundles 里删掉 $PackageName"
  }
}

# ── 2. 删掉目录联接 ─────────────────────────────────────────────────────
$candidates = @(
  (Join-Path $ProfileDir "node_modules\$PackageName"),
  (Join-Path $DshHome "profiles\node_modules\$PackageName")
)
foreach ($link in $candidates) {
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    if ($item.LinkType) {
      # 只删联接本身。用 .Delete() 而不是 Remove-Item -Recurse ——
      # 后者在部分 PowerShell 版本上会顺着联接把目标目录里的真实文件删掉。
      $item.Delete()
      Ok "已删除联接 $link（插件源码目录未动）"
    } else {
      Warn "$link 不是联接（可能是真实目录），为安全起见没有删除"
    }
  }
}

Info ""
Info "=== 完成 ==="
Info "重启实例后本插件即不再加载。插件源码还在，想装回来跑 install.ps1 即可。"
