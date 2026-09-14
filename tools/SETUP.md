# 自动收码转发 — 换机复现指南

目标：在满足 Phone Link 兼容性和交互会话条件的 Windows 电脑上，复现「验证码短信 → 自动确认 → 进入预约队列」。进入队列不等于预约成功，不保证无人值守。

## 方案总览（务必先读，避免走弯路）

验证码短信发到一台 **iPhone**，iPhone 通过 Windows「**手机连接**」(Phone Link) 蓝牙同步到电脑。

- ❌ **不能用「读 Windows 通知中心」那版**（`win-notify-forwarder.ps1`）：实测「手机连接 + iPhone」**不会**把短信推送到 Windows 通知中心（只有来电/设备状态/初始设置三类通知，没有「消息」类），所以通知版抓不到。
- ✅ **用「读软件界面」那版**（`win-phonelink-forwarder.ps1`）：用 UI Automation 直接读「手机连接」窗口里的会话文字，抓「`验证码 : 数字`」，POST 给服务器。**这才是能在你这套环境跑通的方案。**

数据流：
```
iPhone 收到官网短信
  → 「手机连接」界面显示该短信
  → win-phonelink-forwarder.ps1 读到「验证码 : NNNNNN」
  → POST https://<服务器>/api/ingest/sms  （带 SMS_INGEST_TOKEN）
  → 服务器按收码号码匹配订单 → 调官网 confirmCertify → 进抢号队列
```

## 前置条件（新电脑上逐项确认）

1. **Node.js** 已安装且在 PATH（`node -v` 有输出）。
2. 本仓库已拷到该机，并在仓库目录执行过 `npm ci`（装 `axios`）。
3. **「手机连接」已装好、已和那台 iPhone 配对**，能在软件里看到「大韩民国签证申请中心」的会话与短信正文。
4. iPhone 与电脑**蓝牙保持连接**；「手机连接」保持**运行且窗口不要最小化**（见下方「可靠性」）。
5. 仓库根目录有 `.env`，且设置了 `SMS_INGEST_TOKEN`（`.env` 不进 git，每台机要各自建）。

## 一次性配置

在仓库根目录建 `.env`（可从 `.env.example` 复制），至少包含：
```
ADMIN_TOKEN=至少32字符的独立随机串
SMS_INGEST_TOKEN=另一段至少32字符的独立随机串
```
> 转发器使用的 `SMS_INGEST_TOKEN` 必须与 `-Endpoint` 指向的目标服务器配置一致。远程服务器场景也一样；本机 `.env` 中供启动脚本读取的值应匹配目标服务器。

## 启动（每次开机）

**方式 A：手动两条命令**
```powershell
# 1) 启动服务器（仓库根目录）
node server.js

# 2) 启动转发器（新开一个 PowerShell；-Phone 填这台配对 iPhone 的号码）
powershell -ExecutionPolicy Bypass -File tools\start-forwarder.ps1 -Phone "<收码手机号>"
```
`start-forwarder.ps1` 会自动从 `.env` 读 `SMS_INGEST_TOKEN`，你只需给 `-Phone`。
服务器在别的机器/VPS 时，加 `-Endpoint https://你的域名/api/ingest/sms`。

**方式 B：用户登录后自启（需要交互会话）**
```powershell
# 注册当前用户登录后的计划任务（服务器 + 转发器）
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Phone "<收码手机号>"
# 卸载：
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Uninstall
```

## 自检（确认能读到码）

```powershell
powershell -ExecutionPolicy Bypass -File tools\win-phonelink-forwarder.ps1 -Dump
```
末行应打印「已检测到验证码（内容已隐藏）」。短信与验证码不输出到日志；请自行在手机上核对消息。
不一致或读不到，见下方排查。

## 验证全链路（真机一次）

1. 服务器 + 转发器都启动。
2. 有一个「处理中 / 上海中心 / 下单手机号 = 这台 iPhone 号」的订单在等码
   （先在后台明确恢复自动处理；恢复后系统会定期发码）。
3. **短信到达后不要手动填**，看转发器窗口打印
   `新验证码已提交（内容与订单号已隐藏）`，后台该订单验证码状态转「已确认」。

## 可靠性 / 已知坑

- **「手机连接」不要最小化**：它是 UWP 应用，最小化/挂起后界面不再更新，UIA 会读到旧内容、漏掉新码。让窗口保持打开（可放到副屏或后台可见位置）。锁屏或会话挂起也可能影响读取；当前实现不能保证全天无人值守。
- **「消息预览」会滞后**：转发器已改为读「会话内最后一条消息气泡」而非预览，勿改回。
- **一台 iPhone 一个号**：`-Phone` 填这台 iPhone 的号码，服务器据此精确匹配订单。
- **短信格式**：默认按「`验证码 : 数字`」提取。若官网改文案，用 `-CodeRegex` 调整；用 `-Dump` 先看实际正文。
- **别同时开两个转发器**：会重复提交。

## 相关文件

| 文件 | 作用 |
|---|---|
| `tools/win-phonelink-forwarder.ps1` | ✅ 界面读取版转发器（本方案主程序） |
| `tools/start-forwarder.ps1` | 便捷启动：自动从 `.env` 读令牌，只需 `-Phone` |
| `tools/install-autostart.ps1` | 注册/卸载登录自启计划任务 |
| `tools/win-notify-forwarder.ps1` | ❌ 通知中心版（本环境不适用，仅安卓或能进通知中心时可用） |
| 服务器 `POST /api/ingest/sms` | 接收注入的验证码（令牌 `SMS_INGEST_TOKEN`） |
