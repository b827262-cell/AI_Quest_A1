# AI Quest A1

一個零相依、可直接在瀏覽器執行的互動式 AI 學習任務板。

## 功能

- 內建 AI 基礎、提示工程、倫理與實作任務
- 依關鍵字與難度篩選
- 任務完成狀態與學習筆記保存於瀏覽器 `localStorage`
- 顯示完成進度與下一個建議任務
- 響應式介面與深色模式支援
- 使用 Node.js 內建測試工具驗證核心邏輯
- GitHub Actions 持續整合

## 執行

不需安裝套件。可直接開啟 `index.html`，或在專案目錄啟動靜態伺服器：

```bash
python3 -m http.server 8080
```

接著開啟 `http://localhost:8080`。

## 測試

需要 Node.js 20 以上：

```bash
npm test
```

## 專案結構

```text
.
├── index.html
├── styles.css
├── src/
│   ├── app.js
│   └── quest.js
├── tests/
│   └── quest.test.js
└── .github/workflows/ci.yml
```

## 部署

本專案為純靜態網站，可部署至 GitHub Pages、Cloudflare Pages、Netlify 或任何靜態網站主機。

## License

MIT
