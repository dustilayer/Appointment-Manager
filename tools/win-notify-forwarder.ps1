<#
===== KVISA 短信验证码转发器（Windows 通知监听版）=====

用途：Windows「手机连接」(Phone Link) 通过蓝牙同步 iPhone 短信；短信到达时 Windows 会弹通知。
本脚本用官方 UserNotificationListener API 监听这些通知，抓出 4–8 位验证码，
POST 到 KVISA 服务器的 /api/ingest/sms，从而无人化完成「收码 → 确认 → 进抢号队列」。

前置条件（只需一次）：
  设置 → 隐私和安全性 → 通知（或"通知访问权限"）→ 允许应用访问通知，
  并确保列表里的 "Windows PowerShell" 处于开启。首次运行脚本会尝试申请该权限。

用法：
  # 先看看通知长什么样、确认「手机连接」的应用名与短信正文格式（不发送，仅打印）：
  powershell -ExecutionPolicy Bypass -File tools\win-notify-forwarder.ps1 -Dump

  # 正式运行（把 Token 换成 .env 里的 SMS_INGEST_TOKEN）：
  powershell -ExecutionPolicy Bypass -File tools\win-notify-forwarder.ps1 -Token "你的令牌"

参数：
  -Endpoint   服务器注入接口地址，默认 http://localhost:8777/api/ingest/sms
  -Token      SMS_INGEST_TOKEN，必填（-Dump 模式除外）
  -Phone      本机 iPhone 号码；多订单/号池时必填以精确匹配，单订单可省
  -AppMatch   只处理应用名匹配此正则的通知，默认 '手机连接|Phone Link|YourPhone|Link to Windows'
  -CodeRegex  从正文提取验证码的正则，默认 '(\d{4,8})'
  -PollSeconds 轮询间隔秒，默认 3
  -ProcessExisting  连同启动前已存在的旧通知一起处理（默认只处理启动后的新通知）
  -Dump       仅打印当前所有通知后退出，用于排查
#>

param(
  [string]$Endpoint = "http://localhost:8777/api/ingest/sms",
  [string]$Token = "",
  [string]$Phone = "",
  [string]$AppMatch = '手机连接|Phone Link|YourPhone|Link to Windows',
  [string]$CodeRegex = '(\d{4,8})',
  [int]$PollSeconds = 3,
  [switch]$ProcessExisting,
  [switch]$Dump
)

$ErrorActionPreference = 'Stop'
$destination = [uri]$Endpoint
if ($destination.Scheme -ne 'https' -and -not ($destination.Scheme -eq 'http' -and $destination.IsLoopback)) {
  throw '远程验证码转发必须使用 HTTPS；HTTP 仅允许本机地址。'
}

# ---- WinRT 异步等待助手（PowerShell 5.1）----
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# ---- 加载 WinRT 类型 ----
[void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications.Management, ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType=WindowsRuntime]

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current

# ---- 申请/校验通知访问权限 ----
$access = Await ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
if ("$access" -ne 'Allowed') {
  Write-Host "[错误] 未获得通知访问权限（当前：$access）。" -ForegroundColor Red
  Write-Host "请到 设置 → 隐私和安全性 → 通知 → 允许应用访问通知，并开启 'Windows PowerShell'，然后重跑。" -ForegroundColor Yellow
  exit 1
}

function Get-Toasts {
  $op = $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)
  Await $op ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
}

function Read-Toast($n) {
  $appName = ""
  try { $appName = $n.AppInfo.DisplayInfo.DisplayName } catch {}
  $text = ""
  try {
    $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
    if ($binding) { $text = (($binding.GetTextElements() | ForEach-Object { $_.Text }) -join ' ') }
  } catch {}
  [pscustomobject]@{ Id = $n.Id; App = $appName; Text = $text }
}

# ---- Dump 模式：不输出通知正文 ----
if ($Dump) {
  $count = 0
  foreach ($n in Get-Toasts) {
    $t = Read-Toast $n
    if ($AppMatch -and ($t.App -notmatch $AppMatch)) { continue }
    if ([regex]::IsMatch($t.Text, $CodeRegex)) { $count++ }
  }
  Write-Host "匹配验证码的通知数：$count（内容已隐藏）"
  exit 0
}

if (-not $Token) { Write-Host "[错误] 缺少 -Token（.env 里的 SMS_INGEST_TOKEN）" -ForegroundColor Red; exit 1 }

# ---- 主循环 ----
$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
if (-not $ProcessExisting) {
  foreach ($n in Get-Toasts) { [void]$seen.Add([uint32]$n.Id) }
  Write-Host "[启动] 已忽略 $($seen.Count) 条历史通知，只处理新到达的。" -ForegroundColor DarkGray
}

Write-Host "[运行] 监听中 → $Endpoint" -ForegroundColor Green
Write-Host "[运行] 应用过滤: /$AppMatch/   验证码正则: /$CodeRegex/   轮询: ${PollSeconds}s   Ctrl+C 退出" -ForegroundColor DarkGray

while ($true) {
  try {
    foreach ($n in Get-Toasts) {
      $id = [uint32]$n.Id
      if ($seen.Contains($id)) { continue }
      [void]$seen.Add($id)

      $t = Read-Toast $n
      if ($AppMatch -and ($t.App -notmatch $AppMatch)) { continue }
      $m = [regex]::Match($t.Text, $CodeRegex)
      if (-not $m.Success) { continue }
      $code = $m.Groups[1].Value

      $body = @{ code = $code }
      if ($Phone) { $body.phone = $Phone }
      $json = $body | ConvertTo-Json -Compress

      $stamp = (Get-Date).ToString('HH:mm:ss')
      try {
        $resp = Invoke-RestMethod -Uri $Endpoint -Method Post -TimeoutSec 15 `
          -Headers @{ 'X-Ingest-Token' = $Token } -ContentType 'application/json; charset=utf-8' -Body $json
        Write-Host "[$stamp] ✅ 验证码已提交（内容与订单号已隐藏）" -ForegroundColor Green
      } catch {
        $detail = $_.Exception.Message
        try { $detail = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
        Write-Host "[$stamp] ⚠ 验证码提交未完成（响应详情已隐藏）" -ForegroundColor Yellow
      }
    }
    # 防止 seen 集合无限增长
    if ($seen.Count -gt 500) { $seen.Clear() }
  } catch {
    Write-Host "[循环异常] 请检查手机连接与网络状态（详情已隐藏）" -ForegroundColor Red
    Start-Sleep -Seconds 5
  }
  Start-Sleep -Seconds $PollSeconds
}
