# 预约与订单管理工具

前端采用黑白界面，后端使用 Node.js、axios 和 JSON 文件存储。系统包含订单管理、上海中心自动预约流程，以及人工处理入口。

版本功能与验证记录见 [DECISIONS.md](../DECISIONS.md)。早期版本采用人工处理流程，当前版本已加入上海中心自动预约与验证码接入。

## 当前范围

- 创建订单、最多 4 名申请人、日期区间及排除日期、查询和找回订单。
- 上海中心：发送／确认验证码、查询时段、按偏好筛选及提交预约；其他中心需要人工处理。
- 管理后台：验证码处理、人工确认、取消订单、全局和单订单自动处理开关。
- Windows Phone Link 短信界面读取与转发工具，详见 [换机指南](../tools/SETUP.md)。

代码包含上述实现，不代表已完成生产环境验收。开发记录记载了短信匹配订单并进入预约队列的本机联调；进入队列不等于最终预约成功。

## 安装与运行

要求 Node.js 20 或更高版本，以及 npm。克隆仓库后，在仓库根目录执行：

```bash
npm ci
```

将 `.env.example` 复制为 `.env`，至少设置自己的长随机 `ADMIN_TOKEN`，再执行：

```bash
npm start
```

默认地址：http://localhost:8777；管理页面：/admin.html。配置通过环境变量或根目录 `.env` 加载；环境变量优先。管理令牌必须为至少 32 字符的独立随机串，程序不再提供默认令牌。

数据位于 `data/db.json`，首次运行自动创建。当前使用文件存储，应保持单实例运行，并做好备份；不适合直接以多个进程共享该文件。

**新建数据默认暂停自动预约**，仅监听本机地址。确认环境、用户授权及官方服务规则后，才在后台恢复自动处理；旧部署仍沿用已有暂停状态。恢复后会访问官网。单纯检查代码或测试不需要恢复。

## 订单流程

提交后直接进入 `processing`，不再经过支付步骤。运营可确认预约成功（`success`）或取消订单（`cancelled`）。取消只停止后续处理，已发出的官方请求需要另行核对。

人工确认需填写真实受理编号；自动提交后的回执仍需在官网核对。订单找回使用姓名与手机号，不使用交易号。

### 旧数据升级

首次启动时自动备份旧状态数据到 `data/db.json.before-payment-removal.bak`。旧 `paid` 映射为处理中；旧 `pending` 映射为处理中但保持单订单自动暂停，运营确认后再开启；旧 `refunded` 映射为已取消。历史金额和交易字段保留在数据及备份中，不触发任何资金操作。部署前仍应自行备份完整 data 目录。

## 页面与接口

页面：`index.html`、`booking.html`、`order.html`、`recover.html`、`help.html`、`terms.html`、`privacy.html`、`admin.html`。

主要接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/regions | 领区信息 |
| POST | /api/orders | 创建订单及日期偏好 |
| GET | /api/orders/:id | 查询脱敏订单 |
| POST | /api/orders/recover | 找回订单 |
| POST | /api/ingest/sms | 验证码接入与订单匹配 |
| GET | /api/admin/orders | 管理订单列表 |
| POST | /api/admin/orders/:id/request-code | 请求验证码 |
| POST | /api/admin/orders/:id/confirm | 人工确认预约 |
| POST | /api/admin/orders/:id/cancel | 取消订单并清除验证码 |
| POST | /api/admin/orders/:id/auto | 单订单自动处理开关 |

管理接口使用 `Authorization: Bearer <ADMIN_TOKEN>`。短信接入使用独立的 `SMS_INGEST_TOKEN`；未配置时接口关闭。详细路由以 `server.js` 为准。

提交成功通知使用 `ALIYUN_SMS_TPL_SUBMITTED`。升级已有部署时，请按 `.env.example` 设置这个模板变量；旧的付款通知模板变量不再读取。

## 检查与部署

```bash
node --check server.js
npm test
```

测试使用临时目录和暂停的系统状态，验证直接提交、找回、验证码处理、确认、取消与旧数据迁移；不访问官网、不发送真实短信，不代表最终预约或 Windows 转发已通过验证。

Dockerfile 使用锁文件安装生产依赖。容器需持久化 `/app/data`，通过运行时环境变量／安全挂载提供配置；不要把 `.env`、订单文件或日志打进镜像。Linux 容器只能运行后端，Phone Link 转发器仍需 Windows 交互会话。

PM2 配置保持单实例。对外部署需配置 HTTPS、管理令牌、数据备份，并核对预约流程。

## 已知限制

- Phone Link + iPhone 的通知监听方案在记录的环境中不可用；实际使用 UI Automation 读取窗口。
- 窗口最小化、挂起、锁屏或蓝牙中断可能影响收码，不保证 7×24 无人值守。
- 实际成功预约数量、长期稳定性和用户规模未在本仓库形成完整验证证据。
- 本仓库含 AI 辅助开发记录；保留历史与版本差异，不将历史设想当成当前已验证功能。

## 参考来源

早期页面与业务流程参考：`kvisa.catyear.tech`。
