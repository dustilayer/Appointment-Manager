<#
===== KVISA 短信验证码转发器（「手机连接」界面读取版 / UI Automation）=====

背景：Windows「手机连接」(Phone Link) 连 iPhone 时，短信只显示在软件界面里，
不进 Windows 通知中心 —— 所以读通知那版抓不到。本版改用 UI Automation 直接读取
「手机连接」窗口里的会话内容，抓「验证码 : 数字」，POST 到 /api/ingest/sms。

工作方式：变化检测。启动时记录当前最新的码为基线（不提交），之后每次轮询若最新码
发生变化，判定为「新到达」，才提交。避免重复提交历史验证码。

前置：保持「手机连接」处于运行且窗口可读（不要最小化到只剩托盘 / 建议留在短信页）。
      iPhone 与电脑蓝牙保持连接。

用法：
  # 先验证能否读到当前最新验证码（不提交）：
  powershell -ExecutionPolicy Bypass -File tools\win-phonelink-forwarder.ps1 -Dump

  # 正式运行：
  powershell -ExecutionPolicy Bypass -File tools\win-phonelink-forwarder.ps1 -Token "你的令牌" -Phone "<收码手机号>"

参数：
  -Endpoint    默认 http://localhost:8777/api/ingest/sms
  -Token       SMS_INGEST_TOKEN，必填（-Dump 除外）
  -Phone       收码的本机 iPhone 号码；建议填，服务器据此精确匹配订单（单订单可省）
  -CodeRegex   提取验证码正则，默认 '验证码\s*[:：]\s*(\d{4,8})'
  -SenderMatch 只认 Name 含此正则的会话（可选，默认空=只靠上面的验证码格式识别）
  -PollSeconds 轮询间隔秒，默认 3
  -ProcessExisting  连启动前已在界面上的最新码一起提交（默认只处理启动后的新码）
  -Dump        打印当前读到的候选与选中的最新码后退出
#>

param(
  [string]$Endpoint = "http://localhost:8777/api/ingest/sms",
  [string]$Token = "",
  [string]$Phone = "",
  [string]$CodeRegex = '验证码\s*[:：]\s*(\d{4,8})',
  [string]$SenderMatch = "",
  [int]$PollSeconds = 3,
  [switch]$ProcessExisting,
  [switch]$Dump
)

$ErrorActionPreference = 'Stop'
$destination = [uri]$Endpoint
if ($destination.Scheme -ne 'https' -and -not ($destination.Scheme -eq 'http' -and $destination.IsLoopback)) {
  throw '远程验证码转发必须使用 HTTPS；HTTP 仅允许本机地址。'
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-PhoneLinkWindow {
  $proc = Get-Process -Name PhoneExperienceHost -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $proc.Id)
  return $AE::RootElement.FindFirst($TS::Children, $cond)
}

# 返回 [pscustomobject]{ Code; Name } 最新一条含验证码的消息；读不到返回 $null
function Get-LatestCodeInfo {
  $win = Get-PhoneLinkWindow
  if (-not $win) { return $null }
  $all = $win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $hits = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    $n = $null
    try { $n = $e.Current.Name } catch { continue }
    if (-not $n) { continue }
    if ($SenderMatch -and ($n -notmatch $SenderMatch)) { continue }
    $mm = [regex]::Match($n, $CodeRegex)
    if ($mm.Success) {
      [void]$hits.Add([pscustomobject]@{ Name = $n; Code = $mm.Groups[1].Value; Preview = ($n -match '消息预览') })
    }
  }
  if ($hits.Count -eq 0) { return $null }
  # 注意：会话列表「消息预览」会滞后，不可信。会话内消息气泡按时间正序排列，
  # 树里最后一条气泡（非预览）才是最新一条。仅当会话未打开、只剩预览时才退而取预览。
  $msgs = @($hits | Where-Object { -not $_.Preview })
  if ($msgs.Count -gt 0) { return $msgs[$msgs.Count - 1] }
  return $hits[$hits.Count - 1]
}

# ---- Dump 模式：只报告检测状态，不输出短信或验证码 ----
if ($Dump) {
  $latest = Get-LatestCodeInfo
  if ($latest) { Write-Host '已检测到验证码（内容已隐藏）' -ForegroundColor Green }
  else { Write-Host '未检测到验证码' -ForegroundColor Yellow }
  exit 0
}

if (-not $Token) { Write-Host "[错误] 缺少 -Token（.env 里的 SMS_INGEST_TOKEN）" -ForegroundColor Red; exit 1 }

# ---- 主循环（变化检测）----
$lastCode = $null
$boot = Get-LatestCodeInfo
if ($boot -and -not $ProcessExisting) {
  $lastCode = $boot.Code
  Write-Host "[启动] 当前界面已有验证码，作为基线忽略；只提交之后新到达的。" -ForegroundColor DarkGray
} elseif (-not $boot) {
  Write-Host "[启动] 暂未从界面读到验证码（可能会话未加载）。会持续轮询。" -ForegroundColor DarkGray
}

Write-Host "[运行] 监听「手机连接」界面 → $Endpoint" -ForegroundColor Green
Write-Host "[运行] 验证码正则: /$CodeRegex/   轮询: ${PollSeconds}s   Ctrl+C 退出" -ForegroundColor DarkGray

while ($true) {
  try {
    $info = Get-LatestCodeInfo
    if ($info -and $info.Code -ne $lastCode) {
      $code = $info.Code
      $body = @{ code = $code }
      if ($Phone) { $body.phone = $Phone }
      $json = $body | ConvertTo-Json -Compress
      $stamp = (Get-Date).ToString('HH:mm:ss')
      try {
        $resp = Invoke-RestMethod -Uri $Endpoint -Method Post -TimeoutSec 15 `
          -Headers @{ 'X-Ingest-Token' = $Token } -ContentType 'application/json; charset=utf-8' -Body $json
        Write-Host "[$stamp] ✅ 新验证码已提交（内容与订单号已隐藏）" -ForegroundColor Green
        $lastCode = $code   # 成功即认账
      } catch {
        $detail = $_.Exception.Message
        try { $detail = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
        if ($detail -match '没有等待验证码') {
          # 该码此刻没有对应的等码订单（通常是已被确认/已处理）——记为已处理，避免每轮空刷。
          Write-Host "[$stamp] … 读到验证码但暂无等待订单（多为已处理），跳过" -ForegroundColor DarkYellow
          $lastCode = $code
        } else {
          # 官网校验未通过 / 其他：认账，避免拿同一个（错/过期）码反复打官网
          Write-Host "[$stamp] ⚠ 验证码提交未完成（响应详情已隐藏）" -ForegroundColor Yellow
          $lastCode = $code
        }
      }
    }
  } catch {
    Write-Host "[循环异常] 请检查手机连接与网络状态（详情已隐藏）" -ForegroundColor Red
    Start-Sleep -Seconds 5
  }
  Start-Sleep -Seconds $PollSeconds
}
