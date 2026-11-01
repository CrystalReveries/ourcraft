# 部署到 GitHub Pages

本项目是纯静态前端（Babylon.js + Vite），可一键部署到 GitHub Pages。
多人模式的 Node 权威服务器 **无法** 运行在 Pages 上，线上版本为 **单人** 模式。

## 前置条件

- `vite.config.ts` 已设置 `base: "./"`（相对路径），资产在 `/<repo>/` 子路径下能正确加载，无需额外改动。
- 仓库默认分支为 `main`。

## 方式 A：GitHub Actions（推荐，已启用）

仓库已包含 `.github/workflows/deploy.yml`：

- 每次 push 到 `main`（或手动在 Actions 页触发）都会自动 `npm ci && npm run build`，
  把 `dist/` 作为 Pages 制品部署。
- **无需手动维护 `gh-pages` 分支**，也无需在本地构建。

### GitHub 网页端只需确认一次

1. 进入仓库 **Settings → Pages**。
2. **Source（构建与部署）** 应显示为 **GitHub Actions**（首次 Action 成功运行后会自动识别）。
   若仍是 "Deploy from a branch"，改成 **GitHub Actions** 即可。
3. 部署完成后，站点地址为 `https://crystalreveries.github.io/ourcraft/`。

### 验证

- 打开 **Actions** 标签页，查看 `Deploy to GitHub Pages` 工作流是否绿色通过。
- 进入 **Settings → Pages** 或 **Environments → github-pages** 查看线上 URL。
- 调试参数仍可用：`https://.../<repo>/?debug=1&up&day`

## 方式 B：gh-pages 分支（传统方式，仍可用）

不依赖 Actions，本地构建后把 `dist/` 推到 `gh-pages` 分支：

```bash
npm run build
npx gh-pages -d dist          # 首次需 npm i -D gh-pages
```

然后在 **Settings → Pages → Source** 选择 **Deploy from a branch → gh-pages → /root**。

## 注意事项

- **多人模式不可用**：`server/index.ts` 是 WebSocket 权威服务器，Pages 只托管静态文件。
  线上游戏自动回退为单人；`net.ts` 的远端连接会失败但不影响本地游玩。
- 若日后需要公网多人，需另起 Node 服务器（VPS / Render / Fly / Railway 等），
  并把客户端 `net.ts` 的地址指向该服务器。
- 提交前请保证 `npx tsc --noEmit` 零错误，否则 CI 构建会失败。
