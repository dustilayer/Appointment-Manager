<#
注册 / 卸载 KVISA 的开机自启计划任务（登录时自动拉起 服务器 + 转发器）。
需以【管理员】身份运行。

安装：
  powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Phone "<收码手机号>"
卸载：
  powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Uninstall

说明：
- 两个任务：KVISA-Server（node server.js）、KVISA-Forwarder（界面读取版转发器）。
- 触发器 = 当前用户登录时；转发器需要交互桌面（UIA 读「手机连接」界面），故绑定到登录会话，
  不能用「无人登录也运行」。请在受控的交互会话中运行；锁屏后可能暂停，不能保证无人值守。
#>
param(
  [string]$Phone,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$serverTask = 'KVISA-Server'
$fwdTask = 'KVISA-Forwarder'

function Test-Admin {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole([System.Security.Principal.WindowsBuiltinRole]::Administrator)
}
if (-not (Test-Admin)) { Write-Host "[错误] 请以管理员身份运行本脚本。" -ForegroundColor Red; exit 1 }

if ($Uninstall) {
  foreach ($t in @($serverTask, $fwdTask)) {
    try { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop; Write-Host "已卸载任务 $t" -ForegroundColor Green }
    catch { Write-Host "任务 $t 不存在或已卸载" -ForegroundColor DarkGray }
  }
  exit 0
}

if (-not $Phone) { Write-Host "[错误] 安装时必须提供 -Phone（这台配对 iPhone 的号码）" -ForegroundColor Red; exit 1 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "[错误] PATH 里找不到 node，请先装 Node.js" -ForegroundColor Red; exit 1 }
$psExe = (Get-Command powershell).Source
$fwd = Join-Path $here 'start-forwarder.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

# 服务器任务
$serverAction = New-ScheduledTaskAction -Execute $node -Argument 'server.js' -WorkingDirectory $root
Register-ScheduledTask -TaskName $serverTask -Trigger $trigger -Principal $principal -Settings $settings -Action $serverAction -Force | Out-Null
Write-Host "已注册 $serverTask（node server.js @ $root）" -ForegroundColor Green

# 转发器任务
$fwdArg = "-ExecutionPolicy Bypass -WindowStyle Minimized -File `"$fwd`" -Phone $Phone"
$fwdAction = New-ScheduledTaskAction -Execute $psExe -Argument $fwdArg -WorkingDirectory $root
Register-ScheduledTask -TaskName $fwdTask -Trigger $trigger -Principal $principal -Settings $settings -Action $fwdAction -Force | Out-Null
Write-Host "已注册 $fwdTask（转发器 -Phone $Phone）" -ForegroundColor Green

Write-Host ""
Write-Host "完成。下次登录会自动拉起；现在可手动各跑一次验证：" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName $serverTask" -ForegroundColor DarkGray
Write-Host "  Start-ScheduledTask -TaskName $fwdTask" -ForegroundColor DarkGray
Write-Host "提醒：转发器需要「手机连接」保持打开且不最小化，锁屏可能影响读取，不能保证无人值守。" -ForegroundColor Yellow
