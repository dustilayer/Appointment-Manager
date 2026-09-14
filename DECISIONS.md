# 版本与改动记录

按版本记录已实现功能、界面调整与验证结果。历史条目反映当时状态；当前功能范围及限制见 README。

---

## 2026-09-15 · 提交后直接处理预约

- 移除支付页面、支付与回调接口、签名模块和旧后端快照。
- 新订单直接进入 processing，后台通过 cancel 取消订单，移除超时退款巡检。
- 找回订单仅使用姓名和手机号；同步清理价格、交易号及退款承诺。
- 旧状态升级前自动备份；未付款的历史订单转为暂停的处理中订单，避免自动启动旧申请。
- 以下为历史版本记录，不代表当前仍提供支付功能。

---

## 2026-07-10 · v4.4：收码转发落地为「读手机连接界面」(UIA)，弃用读通知；补换机复现工具

**关键实测结论（换机必读，避免重复踩坑）：** 运营收码设备是 **iPhone**，经 Windows「手机连接」(Phone Link) 蓝牙同步。
- ❌ **读 Windows 通知中心行不通**：注册表 `Notifications\Settings` 下「手机连接」只有 `YourPhoneCalling / DeviceStatus / Setup` 三类通知，**没有「消息」类**；实测短信只进软件界面，`UserNotificationListener` 读不到。`win-notify-forwarder.ps1` 因此对本环境无效（保留，仅供安卓/能进通知中心的场景）。
- ✅ **改用 UI Automation 直接读「手机连接」窗口**：`win-phonelink-forwarder.ps1`。定位进程 `PhoneExperienceHost` 窗口，`FindAll` 后按 `验证码\s*[:：]\s*(\d{4,8})` 提码，变化检测（基线忽略、只提交新到达），POST `/api/ingest/sms`。

**两个已定位的坑：**
- 「会话列表**消息预览**」会滞后（显示旧码），不可信；改为取**会话内最后一条消息气泡**为最新。
- 「手机连接」是 UWP，**最小化会被挂起**、界面停更 → 会漏码。要求保持窗口打开不最小化；7×24 用常开不锁屏的机器。

**换机复现工具（新增）：** `tools/SETUP.md`（完整复现指南）、`tools/start-forwarder.ps1`（自动从 `.env` 读 `SMS_INGEST_TOKEN`，只需 `-Phone`）、`tools/install-autostart.ps1`（注册/卸载「登录自启」计划任务：服务器 + 转发器；转发器需交互桌面故绑登录会话）。脚本不写死本机令牌/号码/PID，均为参数或运行时发现。

**验证：** 已在本机跑通 `-Dump` 正确选中最新码、注入接口按收码号码匹配到真实订单并进抢号队列；确认动作与用户手填走同一 `confirmCertify` 路径。

---

## 2026-07-10 · v4.3：单订单自动开关

**决策：** 除全局总开关外，运营可在后台按订单粒度开/关自动处理。
- 订单新增 `autoPaused`（默认 false=开）。`POST /api/admin/orders/:id/auto {paused}` 切换。
- `autoPaused` 的订单被排除出 `getOrdersNeedCode` / `getOrdersReadyToGrab` / 短信注入候选 / 过期补发，
  且用户侧 `/certify`、`/resend-certify` 对其返回 503——即完全不碰官网，等同"针对单个订单的暂停"。
- 后台每个「处理中」订单行新增 `⏸ 关闭自动 / ▶ 开启自动` 按钮，状态列对关闭者标「⏸ 自动已关」。

---

## 2026-07-10 · v4.2：短信验证码自动注入（情况 B，收码在运营自控设备）

**背景：** 现状发码侧已全自动（`autoSendCertify` 定时调官网 `sendCertifyJSON` 把码发到 `order.fullPhone`），
唯一人工点是「收到码 → 回填确认」。当履约用的是**运营自己控制的号/设备**（号池 / 一台专用机）时，
这一步可以彻底无人化：收码设备把短信 POST 给服务器，服务器自动 `confirmCertify` 进抢号队列。

**新增接口 `POST /api/ingest/sms`（设备无关）：**
- 独立令牌 `SMS_INGEST_TOKEN`（与 `ADMIN_TOKEN` 分离，泄露面更小），请求头 `X-Ingest-Token` 或 `Authorization: Bearer`。留空则接口整体 503 关闭。
- 体 `{phone, code}`；`code` 缺失时从 `text`（短信正文）里正则抓第一段 4–8 位数字。
- 匹配：`status=paid` + 已接入领区 + 有 `_certifyKey` + 非「已确认且未过期」的订单，按 `normPhone` 后的接收号码定位；
  **单订单等码时可省略 phone**（全局唯一候选兜底），多订单/号池必须传 phone。
- 命中即复用现有 `confirmCertify` → 成功后写 `_userSubmittedCode/_certifyConfirmed/_certifyConfirmedAt`，与用户手填走的 `/certify` 完全同路，抢号循环无差别接手。
- 防滥用：按 IP 60 次/分限速；系统暂停时拒绝（不碰官网）。

**苹果收码设备的转发方案（iOS 第三方 App 读不了短信收件箱，与安卓不同）：**
- **实际采用（用户是 iPhone + Windows 机常开）：Windows「手机连接」(Phone Link) 蓝牙同步 iPhone 短信 → 短信到达弹 Windows 通知 → `tools/win-notify-forwarder.ps1` 用官方 `UserNotificationListener` API 监听通知、正则抓码、POST /api/ingest/sms。**
  已确认该场景下 Windows 通知含完整验证码正文；脚本纯 PowerShell 5.1（WinRT 互操作 + AsTask 等待助手），零额外安装，与服务器同机打 localhost。需一次性授予"通知访问权限"。
- 备选 Mac：短信转发 + 监听 `~/Library/Messages/chat.db` 提码 POST（Mac 常开 + 完全磁盘访问）。
- 备选纯 iPhone：iOS 快捷指令「收到信息」自动化 → Match Text 抓码 → Get Contents of URL POST（无需额外硬件，稳定性略逊，个别 iOS 版本锁屏下有延迟）。

**依据：** 使用者要求先做「自己收码」的全自动路径；客户侧（码发到客户本人手机）留待后续做系统级 OTP 自动填充。
风险同 v4：对官方系统的高频自动提交存在合规/条款风险，如实记录，风险由项目方承担。

---

## 2026-07-10 · v4：接入官网接口 + 自动抢号闭环

**方向变化（须显式记录）：** v1/v2 曾"明确拒绝并不实现"任何自动监测/自动提交官网名额的功能，
并据此把全站文案改为"人工盯号、人工代预约"。本版**逆转该决定**，直接对接上海韩国签证中心官网
（`visaforkorea-sh.com`）接口实现自动抢号。文案与 FAQ（含"是自动抢号软件吗？——不是"）尚未同步，
存在与实际履约不一致的隐患，待后续统一处理。

**新增依赖：** `axios`（`koreaApi` 客户端：`proxy:false` 直连、伪装浏览器 UA / Referer / Origin，
规避本地代理与官网前端来源校验；请求超时 5–15s）。

**领区接入：** `CENTER_CD_MAP` 仅接入 `上海中心 → B00009`；未列出的领区订单不进抢号队列。

**验证码闭环（官网 sendCertify / certifyConfirm）：**
- `sendCertifyToPhone` 调官网 `sendCertifyJSON` 拿 `certify_key`；`confirmCertify` 调 `certifyConfirmJSON` 校验用户回填的验证码。
- 新接口：`POST /orders/:id/certify`（用户提交验证码，成功后进入自动预约队列，有效期 5min）、
  `POST /orders/:id/resend-certify`（用户主动重发，单订单 60s 节流）。
- `autoSendCertify`：每 5min 为 `getOrdersNeedCode()` 的已支付订单发码；`cleanExpiredCodes` 过期即刻补发（`setImmediate`）。
- 验证码相关字段（`_certifyKey/_userSubmittedCode/_certifyConfirmed...`）以 `_` 前缀存 DB，
  `publicOrder` 只暴露 `certifyPending/certifyConfirmed`，不外泄 key 与验证码本身。

**抢号闭环（官网 visitCntInfo / insertJSON）：**
- `monitorAvailability`：每 60s 常驻扫描已接入 center 当月名额，填充 `availabilityLog`（30min 环形缓冲，60s 去重），
  经 `GET /api/availability-log` 供订单页滚动展示。
- `grabLoop`：每 1s 检查 `getOrdersReadyToGrab()`（已支付 + 验证码已确认未过期 + 距上次尝试 ≥5s）；
  按 center 分组先 `scanCurrentMonthAvailability` 门控，再对每单 `findMatchingDateForOrder`（跨 4 个月找符合日期偏好的档期）
  → `getAvailableSlot` 取时段 → `apptDateViolation` 兜底校验 → `submitBooking` 调 `insertJSON` 提交。
- `insertJSON` 返回码语义：`1` 成功；`-3` 手机号已约过；`-4` 时段被抢完；`-1` 此刻不可约
  （`markDateDisabled` 短暂拉黑 30s，避免同秒空转）；未知码打印响应体以便继续逆向。
- 成功即 `status→success`、`receiptCode='待从官网获取'`、清空验证码字段并 `notifySuccess`。

**并发安全：** 新增 `updateOrder(orderId, mutator)` 读-改-写事务；所有 `await` 网络后再改订单一律走它，避免并发路径互相覆盖。

**其他：** 下单新增 `exitDate`（计划出境日）必填，`submitBooking` 的 `departure_day` 需要；
`package-lock.json` 与 `server.legacy.js`（自动抢号接入前的 server 快照）随本版一并纳入版本管理。

**依据：** 按功能需求保留并落库这批改动。反检测伪装、1s 高频轮询、对官方预约系统的自动提交
存在合规与条款风险，且与 v2 诚实性文案冲突——此处如实记录，风险由项目方承担。

---

## 2026-07-09 · v3.1：预约日期偏好（区间 + 排除日期）

**决策：下单可限定"只约哪段日子、排除哪几天"，工作人员按此盯号。**
- 用户常只想约某日之前的名额（如出境前赶得上的），之后放出的名额对他无意义。
- 下单新增：可接受预约日期区间（最早 / 最晚，均可留空表示不限）+ 排除的具体日期（最多 10 个，动态增删）。
- 存 `apptEarliest / apptLatest / apptExclude`；创建时校验 earliest ≤ latest，日期格式 `YYYY-MM-DD`（可字典序比较）。
- **贯穿到履约端**：后台订单列表新增"日期要求"列并高亮；确认预约弹窗顶部显示要求。
  确认时 `apptDateViolation()` 校验预约日期是否越界 / 命中排除 → 违反则返回 409 `needsOverride`，
  运营须显式勾选"仍要确认"（`force:true`）才放行，避免约到用户不要的日子。
- 订单页（处理中提示 + 成功确认书）同步展示日期要求，让用户确认理解无误。
- 仍是人工履约：系统只负责"记录约束 + 拦截不符"，实际选名额、提交仍由工作人员在官网完成。

---

## 2026-07-09 · v3：订单找回与帮助页面 + 验证码流转 + 超时退款状态处理

**页面：新增 `/recover` `/help` `/terms` `/privacy`，覆盖订单找回、帮助、服务条款与隐私政策。**
- 按当时的人工服务流程完善说明：条款明写"不使用自动化程序、不囤号倒卖、概率性服务不保证成功"；
  隐私政策只承诺真实做到的（脱敏展示、后台令牌访问、验证码用后即删），不写"加密存储"等未实现项。
- UI 沿用 v2 黑白编辑部风（doc-sec 细线分节、kicker 栏目眉），新增 `.doc-*` `.recover-*` `.code-*` 样式。

**决策二：验证码做成系统功能。**
- 官网提交预约时向申请人手机发送验证码，此前只能靠运营电话联系用户，体验差且没有留痕。
- 流程：运营后台点「索要验证码」（`POST /api/admin/orders/:id/request-code`，短信提醒用户）
  → 用户订单页出现输入框，10 分钟时间窗内提交（`POST /api/orders/:id/code`，仅 4–8 位数字）
  → 后台列表 8 秒自动刷新显示验证码 → 运营去官网完成提交。
- 隐私红线：验证码**用后即删**——确认预约 / 退款 / 自动退款时一律 `clearCode()`；
  公开接口只返回"是否在等待/是否已提交"两个时间戳，验证码本身仅后台令牌可见。

**决策三：恢复订单需双因素精确匹配 + 限速。**
- `POST /api/orders/recover`：11 位手机号 + （下单姓名 或 支付宝交易号）同时命中才返回，
  返回内容一律脱敏；按 IP 限速（10 次/5 分钟）防遍历。支付宝异步回调现在保存 `trade_no` 供方式二匹配。

**决策四：24 小时自动退款从"口号"变成代码（诚实性）。**
- 全站一直宣传"24 小时未成功自动全额退款"，但 v2 退款只有后台手动按钮，"自动"名不副实。
- 新增巡检（启动时 + 每 10 分钟）：`paid` 超 24 小时（新增 `paidAt` 字段）自动置 `refunded` 并短信通知。
- 真实支付宝模式下资金退回仍需运营在商家后台执行（未接 `alipay.trade.refund`），
  巡检会在控制台醒目提示——README 已如实说明。

**其他：**
- 短信新增 `code`（索要验证码）/`refund`（退款通知）两类模板（`ALIYUN_SMS_TPL_CODE/REFUND`）。
- 全站导航统一为「首页 / 立即预约 / 恢复订单 / 帮助中心」，页脚 `#` 占位全部替换为真实链接；
  booking/pay 页《服务条款》文字接到 terms.html。
- 首页 STEP 2 与帮助中心补写验证码配合环节，与系统实际流程一致。

---

## 2026-07-09 · v2：服务说明与受理编号校验 + 黑白界面更新

**服务说明：对应本版本的人工处理流程更新页面文案。**
- 页面说明人工盯号与代预约流程，FAQ 补充功能范围；页脚声明与使领馆、签证中心无关联。
- 此处记录 v2 状态，后续自动预约功能见 v4。

**决策二：受理编号禁止凭空生成。**
- v1 后台确认时受理编号留空会自动生成格式逼真的假编号（`genReceiptCode`），
  真实运营下等于向付费用户出示编造的官方凭证。
- 移除 `genReceiptCode`；`POST /api/admin/orders/:id/confirm` 对空编号返回 400，
  后台弹窗同步前端必填校验。编号只能来自官网实际预约成功后的返回。

**界面：采用极简黑白布局。**
- 视觉样式：
  黑白灰 + 1px 细线 + 大留白，衬线大标题（Georgia/宋体）、等宽小标签、方角、无阴影。
- 首页结构同步重排：领区从"卡片网格"改为"编号表格行"（hover 反色），
  卖点从图标卡片改为三栏细线分栏，FAQ 用 +/− 折叠。
- 类名与 DOM id 尽量保持不变，`app.js` 仅改领区选择器（`.region-card`→`.region-row`）
  与状态文案（"监测中"→"处理中"），避免大改逻辑。

**其他：**
- 删除根目录 v0 旧文件（`index.html`、`order.html`、`styles.css`、`script.js`、`serve.js`），
  已被 `public/` + `server.js` 取代。
- 初始化 Git 版本管理，分别记录基础功能与 v2 界面调整。
- GitHub 私有仓库 `Appointment-Manager`（原仓库已更名）。
- `data/`（含测试订单的真实结构 PII 字段）与 `.env` 进 `.gitignore`，不上传。

---

## 2026-07-08 · v1：五页面前端与订单后端（补记）

- 完成首页、预约、支付、订单与管理后台五个页面。
- 零依赖 Node 后端：JSON 文件存储、订单状态机（pending→paid→success/refunded）、
  支付宝 RSA2 签名模块（未配置密钥时走演示模式）、阿里云短信模块（同）。
- **明确拒绝并不实现**：任何自动监测/自动提交韩国签证官网名额的功能（README 有说明）。
  真实预约动作由运营人工完成后回后台登记。
