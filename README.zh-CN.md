[繁體中文](README.md) ｜ [简体中文](README.zh-CN.md) ｜ [English](README.en.md)

# 预约与订单管理工具

支持日期偏好、验证码接入、状态跟踪与后台管理。提交后直接进入处理流程，不包含支付功能。上海中心有自动预约实现，其他领区由运营人员处理；进入队列不等于预约成功。

## 本地运行

安装 Node.js 20 或更高版本，在仓库目录执行：

```sh
npm ci
npm test
```

复制 `.env.example` 为 `.env`，用下面的命令生成随机令牌，填入 `ADMIN_TOKEN`。不要上传 `.env`。

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

配置完成后执行 `npm start`，打开 http://localhost:8777；后台地址为 `/admin.html`。新建数据默认暂停自动预约，仅监听本机。确认使用范围和官方规则后，才在后台恢复；恢复会访问官网。

当前使用单实例 JSON 文件存储。Phone Link 依赖 Windows 交互会话；最终预约和长期稳定性仍需真机验证。公开代码不等于上线服务。

- [详细使用说明](docs/usage.md)
- [安全与隐私](SECURITY.md)
- [Phone Link](tools/SETUP.md)
