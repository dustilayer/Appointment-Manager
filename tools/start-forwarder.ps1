<#
便捷启动「手机连接」界面读取版转发器。
自动从仓库根目录 .env 读取 SMS_INGEST_TOKEN，你只需给 -Phone。

用法：
  powershell -ExecutionPolicy Bypass -File tools\start-forwarder.ps1 -Phone "<收码手机号>"
  # 服务器在别处时：
  powershell -ExecutionPolicy Bypass -File tools\start-forwarder.ps1 -Phone "<收码手机号>" -Endpoint https://你的域名/api/ingest/sms
#>
param(
  [Parameter(Mandatory = $true)][string]$Phone,
  [string]$Endpoint = "http://localhost:8777/api/ingest/sms"
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
  Write-Host "[错误] 找不到 $envFile —— 请先在仓库根目录创建 .env 并设置 SMS_INGEST_TOKEN" -ForegroundColor Red
  exit 1
}
$line = Get-Content $envFile | Where-Object { $_ -match '^\s*SMS_INGEST_TOKEN\s*=' } | Select-Object -First 1
$token = ''
if ($line) { $token = ($line -replace '^\s*SMS_INGEST_TOKEN\s*=\s*', '').Trim().Trim('"').Trim("'") }
if (-not $token) {
  Write-Host "[错误] .env 里 SMS_INGEST_TOKEN 为空或未设置" -ForegroundColor Red
  exit 1
}
& (Join-Path $here "win-phonelink-forwarder.ps1") -Token $token -Phone $Phone -Endpoint $Endpoint
