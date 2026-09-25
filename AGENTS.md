# SuperMidiAgent 开发约定

## 发布流程（必须遵守）

1. **改动完成后不要推送到 Git 远程**（不 push、不打远程 tag、不触发 Release）。
2. 先做本地构建供用户测试：
   - `npm run build && npx electron-builder --dir` → 测试用程序在 `release\win-unpacked\SuperMidiAgent.exe`
   - 用户要求安装版时才跑 `npm run dist`
3. **只有用户明确说"发布"之后**才允许：
   - `git push origin main`
   - `npm version patch && git push --follow-tags`（打 tag 触发 GitHub Actions 自动发布三平台 Release）
4. 本地 `git commit` 可以随时做检查点，但 push 必须等用户指示。

## 密钥安全（必须遵守）

- API Key 等密钥一律不进仓库：测试通过环境变量（`TEST_API_KEY` / `TEST_MODEL` / `TEST_BASE_URL`）提供。
- 用户的模型配置只存在于本机 `%APPDATA%\SuperMidiAgent\settings.json`，不属于仓库。
- 提交前运行 `node scripts/secret-scan.mjs` 确认无泄漏。

## 常用命令

- `npm test` — 单元测试（85+ 用例）
- `npm run typecheck` — TypeScript 检查
- `npm run dev` — 开发模式（vite 热更新 + electron）
- `npm run build` — 构建主进程与渲染进程
- `npm run test:live` — 真实 API 集成测试（需 `RUN_LIVE=1 TEST_API_KEY=...`）
- `node scripts/gui-test.mjs` — GUI 端到端测试（自行启动应用，需 CDP 端口 9222）

## 测试基线

- 单元测试必须全过；涉及 UI/流程改动时跑 `gui-test.mjs`（真实模型，需 `TEST_API_KEY`）。
- MIDI 解析/写入的任何改动都要保持 round-trip 一致（见 tests/midi-core.test.ts 的回归用例）。
