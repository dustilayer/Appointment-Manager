[繁體中文](README.md) ｜ [简体中文](README.zh-CN.md) ｜ [English](README.en.md)

# 預約與訂單管理工具

支援日期偏好、驗證碼接入、狀態追蹤與後台管理。提交後直接進入處理流程，不包含支付功能。上海中心有自動預約實作，其他領區由營運人員處理；進入佇列不等於預約成功。

## 本機執行

安裝 Node.js 20 或更高版本，在倉庫目錄執行：

```sh
npm ci
npm test
```

複製 `.env.example` 為 `.env`，用下方命令產生隨機權杖，填入 `ADMIN_TOKEN`。不要上傳 `.env`。

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

設定完成後執行 `npm start`，開啟 http://localhost:8777；後台位址為 `/admin.html`。新建資料預設暫停自動預約，僅監聽本機。確認使用範圍與官方規則後，才在後台恢復；恢復會存取官網。

目前採單實例 JSON 檔案儲存。Phone Link 依賴 Windows 互動工作階段；最終預約與長期穩定性仍需真機驗證。公開程式碼不等於上線服務。

- [詳細使用說明](docs/usage.md)
- [安全與隱私](SECURITY.md)
- [Phone Link](tools/SETUP.md)
