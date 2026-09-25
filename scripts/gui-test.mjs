/**
 * SuperMidiAgent GUI 端到端测试。
 * 脚本自行启动应用（--remote-debugging-port=9222 + SUPERMIDI_MOCK_DRAG=1）并在结束后关闭。
 * 运行：node scripts/gui-test.mjs
 */
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const SHOT_DIR = 'tmp/gui-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
let page;
let browser;
let electronProc = null;

function ok(name, cond, extra = '') {
  const status = cond ? 'PASS' : 'FAIL';
  results.push({ name, status, extra });
  console.log(`  [${status}] ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function shot(name) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  [shot] ${file}`);
}

async function startApp() {
  try {
    execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' });
  } catch {
    // 没有运行中的实例
  }
  await new Promise((r) => setTimeout(r, 1200));
  electronProc = spawn(electronBin, ['.', '--remote-debugging-port=9222'], {
    cwd: process.cwd(),
    env: { ...process.env, SUPERMIDI_MOCK_DRAG: '1' },
    stdio: 'ignore',
    shell: true,
  });
  // 等待 CDP 就绪
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://localhost:9222/json/version');
      if (res.ok) return;
    } catch {
      // 未就绪
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('CDP 端口未就绪');
}

async function stopApp() {
  try {
    execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

const consoleErrors = [];
async function connect() {
  browser = await chromium.connectOverCDP('http://localhost:9222');
  page = browser.contexts()[0].pages()[0];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
}

async function waitRunDone(timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await page.locator('[data-testid="chat-panel"][data-running="true"]').count();
    if (running === 0) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function sendPrompt(text) {
  await waitRunDone();
  const input = page.locator('[data-testid="sender-input"] textarea, [data-testid="sender-input"] >> textarea');
  await input.fill(text);
  await input.press('Enter');
}

async function waitMidiCards(count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await page.locator('[data-testid="midi-card"]').count();
    if (n >= count) return n;
    await page.waitForTimeout(1500);
  }
  return page.locator('[data-testid="midi-card"]').count();
}

async function waitForText(len, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.evaluate(() => document.body.innerText);
    if (last.length >= len) return last;
    await page.waitForTimeout(1200);
  }
  return last;
}

// ============ 测试开始 ============
console.log('\n== 0. 启动应用 ==');
await startApp();
console.log('  应用已启动，CDP 就绪');

console.log('\n== 1. 连接应用 ==');
await connect();
ok('CDP 连接', !!page);
await page.evaluate(() => localStorage.removeItem('supermidi.sessions.v1'));
await page.reload();
await page.waitForSelector('[data-testid="sender-input"]', { timeout: 20000 });
ok('页面加载', true);

console.log('\n== 2. 配置模型服务（通过 preload API 注入；密钥只来自环境变量）==');
const ENV_MODEL = process.env.TEST_MODEL ?? 'MiniMax-M3';
const ENV_BASE_URL = process.env.TEST_BASE_URL ?? 'https://api.minimax.cn/v1';
const ENV_API_KEY = process.env.TEST_API_KEY ?? '';
const seeded = await page.evaluate(async ({ model, baseUrl, apiKey }) => {
  await window.api.settingsUpsertProfile({
    id: 'minimax-gui',
    name: model,
    baseUrl,
    apiKey,
    model,
    temperature: 0.7,
  });
  await window.api.settingsSet({ activeProfileId: 'minimax-gui' });
  const s = await window.api.settingsGet();
  return s.activeProfileId;
}, { model: ENV_MODEL, baseUrl: ENV_BASE_URL, apiKey: ENV_API_KEY });
ok('模型配置注入', seeded === 'minimax-gui', `activeProfileId=${seeded}`);
if (!ENV_API_KEY) {
  console.log('  [warn] 未设置 TEST_API_KEY 环境变量——依赖真实模型的测试步骤将失败');
}

console.log('\n== 3. 设置界面检查 ==');
await page.locator('[data-testid="open-settings"]').click();
await page.waitForSelector('[data-testid="default-profile-select"]', { timeout: 10000 });
await shot('03-settings-models');
const profileCard = await page.locator(`[data-profile-name="${ENV_MODEL}"]`).count();
ok('模型配置卡片显示', profileCard === 1);

// 测试连接（真实 API）
await page.locator(`[data-profile-name="${ENV_MODEL}"] button:has-text("测试")`).click();
const testResult = await page
  .waitForSelector('.ant-message-success, .ant-message-error', { timeout: 30000 })
  .then(() => page.locator('.ant-message').innerText())
  .catch(() => 'timeout');
ok('模型连接测试（真实 API）', /连接成功/.test(testResult), testResult.slice(0, 60));

// MCP 标签
await page.locator('[data-testid="tab-mcp"]').click();
await page.waitForTimeout(600);
const mcpCard = await page.locator('[data-mcp-name="midi"]').count();
const mcpStatus = await page.locator('[data-mcp-name="midi"]').getAttribute('data-mcp-status');
ok('内置 MIDI MCP 服务显示', mcpCard === 1 && mcpStatus === 'connected', `status=${mcpStatus}`);
await shot('04-settings-mcp');

// 知识库标签 + 添加测试文档
await page.locator('[data-testid="tab-kb"]').click();
await page.waitForTimeout(400);
const kbDoc = path.join(process.cwd(), 'tmp', 'kb-midi-knowledge.md');
fs.writeFileSync(
  kbDoc,
  '# CC11 表情控制器使用指南\n\nCC11 是 MIDI 中的表情控制器（Expression），数值 0-127。\n在弦乐、管乐等持续性音色中，CC11 用于塑造乐句的强弱起伏，\n让程序生成的音乐听起来更像真人演奏。典型做法是每个乐句画一条弧线：\n起音约 80，乐句中部达到峰值 105-115，句尾回落到 75 左右。\n\n# 力度人性化\n\n真实演奏的力度受节拍位置、乐句走向、音高与音长影响：\n小节头音最强，弱拍较弱，乐句高潮处最强；\n同轨道音符力度差应达到 20-40 才有真实感。\n',
  'utf8',
);
const kbStats = await page.evaluate(async (p) => window.api.kbAddPaths([p]), kbDoc);
ok('知识库导入', kbStats.totalChunks >= 1, `chunks=${kbStats.totalChunks}`);
// 搜索测试
await page.locator('[data-testid="kb-search-input"]').fill('CC11 表情控制器 怎么用');
await page.locator('[data-testid="kb-search-btn"]').click();
await page.waitForTimeout(800);
const kbHit = await page.locator('.kb-result').count();
ok('知识库检索测试', kbHit >= 1, `results=${kbHit}`);
await shot('05-settings-kb');

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.locator('.ant-drawer-close').click().catch(() => {});
await page.waitForTimeout(400);

console.log('\n== 4. AI 生成 MIDI（真实模型）==');
await sendPrompt('请生成一段 C 大调、120bpm、8 小节的钢琴旋律，要有乐句起伏。直接创作，不用问我。');
const cardCount1 = await waitMidiCards(1, 240000);
ok('生成后出现 MIDI 卡片', cardCount1 >= 1, `cards=${cardCount1}`);
await page.waitForTimeout(1200);
await shot('06-generated-midi');

const cardMeta = await page.locator('[data-testid="midi-card"]').first().innerText();
ok('卡片含元数据', /BPM/.test(cardMeta) && /小节/.test(cardMeta), cardMeta.split('\n').slice(0, 2).join(' | ').slice(0, 80));
const hasRoll = await page.locator('[data-testid="piano-roll"]').count();
ok('钢琴卷帘渲染', hasRoll >= 1);

// 工具调用显示
const toolCount = await page.locator('[data-testid="tool-activity"]').count();
ok('工具调用活动展示', toolCount >= 1, `tools=${toolCount}`);

console.log('\n== 5. 播放 ==');
const timeBefore = await page.locator('.midi-time').first().innerText();
await page.locator('[data-testid="midi-play"]').first().click();
await page.waitForTimeout(2500);
const playingLabel = await page.locator('[data-testid="midi-play"]').first().getAttribute('aria-label');
const timeAfter = await page.locator('.midi-time').first().innerText();
ok('播放状态切换', playingLabel === '暂停', `aria-label=${playingLabel}`);
ok('播放进度推进', timeBefore !== timeAfter, `${timeBefore} → ${timeAfter}`);
await shot('07-playing');
await page.locator('[data-testid="midi-play"]').first().click(); // 暂停
await page.waitForTimeout(300);
const stoppedLabel = await page.locator('[data-testid="midi-play"]').first().getAttribute('aria-label');
ok('暂停生效', stoppedLabel === '播放', `aria-label=${stoppedLabel}`);

console.log('\n== 6. 下载 ==');
const midiIdForDl = await page.locator('[data-testid="midi-card"]').first().getAttribute('data-midi-id');
const dlRes = await page.evaluate(async (id) => window.api.midiQuickDownload(id, 'download-test'), midiIdForDl);
ok('下载 IPC 成功', dlRes && dlRes.ok === true, dlRes?.path ?? JSON.stringify(dlRes));
let downloadedPath = null;
if (dlRes?.ok && dlRes.path && fs.existsSync(dlRes.path)) {
  downloadedPath = dlRes.path;
  const head = fs.readFileSync(downloadedPath).subarray(0, 4).toString('latin1');
  ok('下载文件为合法 MIDI (MThd)', head === 'MThd', `header=${head}`);
}
// UI 按钮反馈
await page.locator('[data-testid="midi-download"]').first().click();
await page.waitForTimeout(1200);
const dlMsg = await page.locator('.ant-message').innerText().catch(() => '');
ok('下载成功提示', /已保存到/.test(dlMsg), dlMsg.slice(0, 80));

console.log('\n== 7. 拖拽导出（mock 模式验证 IPC 与文件准备）==');
const midiId = await page.locator('[data-testid="midi-card"]').first().getAttribute('data-midi-id');
const dragResult = await page.evaluate(async (id) => {
  try {
    return await window.api.midiDrag(id, 'drag-test');
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}, midiId);
ok('拖拽 IPC 调用', dragResult && dragResult.ok === true, JSON.stringify(dragResult).slice(0, 80));
if (dragResult?.mocked) {
  const dragFileExists = fs.existsSync(dragResult.file);
  const dragHeader = dragFileExists ? fs.readFileSync(dragResult.file).subarray(0, 4).toString('latin1') : '';
  ok('拖拽文件已准备且为合法 MIDI', dragFileExists && dragHeader === 'MThd', dragResult.file);
}
const appAlive2 = await page.evaluate(() => document.title);
ok('拖拽后应用仍响应', appAlive2 === 'SuperMidiAgent', `title=${appAlive2}`);
await page.waitForTimeout(500);

console.log('\n== 8. 上传 MIDI（附件模式：不自动发送）==');
if (downloadedPath) {
  const userMsgsBefore = await page.locator('[data-testid="user-message"]').count();
  const runsBefore = await page.evaluate(() => document.querySelectorAll('[data-testid="tool-activity"]').length);
  await page.setInputFiles('[data-testid="midi-file-input"]', downloadedPath);
  await page.waitForTimeout(1500);
  const chips = await page.locator('[data-testid="pending-attachments"] .pending-chip').count();
  ok('上传后出现附件条', chips >= 1, `chips=${chips}`);
  const userMsgsAfter = await page.locator('[data-testid="user-message"]').count();
  ok('附件不自动发送', userMsgsAfter === userMsgsBefore, `用户消息 ${userMsgsBefore} → ${userMsgsAfter}`);

  // 输入说明并发送
  const input = page.locator('[data-testid="sender-input"] textarea');
  await input.fill('请分析这个 MIDI 文件');
  await input.press('Enter');
  const deadline = Date.now() + 240000;
  let toolAfter = runsBefore;
  while (Date.now() < deadline) {
    toolAfter = await page.evaluate(() => document.querySelectorAll('[data-testid="tool-activity"]').length);
    if (toolAfter > runsBefore) break;
    await page.waitForTimeout(2000);
  }
  ok('发送后触发工具调用', toolAfter > runsBefore, `tools ${runsBefore} → ${toolAfter}`);
  const done = await waitRunDone(240000);
  ok('分析回复完成', done);
  await page.waitForTimeout(800);
  await shot('08-uploaded-analysis');
  const analysisText = await page.evaluate(() => document.body.innerText);
  ok('分析包含音乐要素', /调|和弦|力度|小节/.test(analysisText), '分析文本包含音乐术语');
  const cardCountAfterUpload = await page.locator('[data-testid="midi-card"]').count();
  ok('分析不产生重复卡片', cardCountAfterUpload === 2, `cards=${cardCountAfterUpload}`);
  const chipsAfterSend = await page.locator('[data-testid="pending-attachments"] .pending-chip').count();
  ok('发送后附件条清空', chipsAfterSend === 0, `chips=${chipsAfterSend}`);
} else {
  ok('上传分析（跳过：无下载文件）', false, '前置下载失败');
}

console.log('\n== 9. 请求添加真实力度与 CC11 ==');
const toolsBeforeModify = await page.locator('[data-testid="tool-activity"]').count();
const cardsBeforeModify = await page.locator('[data-testid="midi-card"]').count();
await sendPrompt('请给刚才上传的这个 MIDI 增加真实的力度起伏和 CC11 表情控制，生成修改版本。');
// 等待修改工具被调用
const deadline9 = Date.now() + 240000;
let tools9 = toolsBeforeModify;
while (Date.now() < deadline9) {
  tools9 = await page.locator('[data-testid="tool-activity"]').count();
  if (tools9 > toolsBeforeModify) break;
  await page.waitForTimeout(2000);
}
ok('修改触发工具调用', tools9 > toolsBeforeModify, `tools ${toolsBeforeModify} → ${tools9}`);
const cardCount2 = await waitMidiCards(cardsBeforeModify + 1, 240000);
ok('修改版 MIDI 卡片出现', cardCount2 >= cardsBeforeModify + 1, `cards ${cardsBeforeModify} → ${cardCount2}`);
await waitRunDone(240000);
await page.waitForTimeout(1500);
await shot('09-modified-with-cc11');
const lastAssistantText = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll('.msg-content'));
  return nodes[nodes.length - 1]?.textContent ?? '';
});
ok('修改操作反馈可见', /humanize|CC11|修改|力度/.test(lastAssistantText), lastAssistantText.slice(0, 80));

console.log('\n== 10. 会话管理 ==');
await page.locator('[data-testid="new-chat"]').click();
await page.waitForTimeout(800);
const welcomeBack = await page.locator('.welcome-wrap').count();
ok('新建会话回到欢迎页', welcomeBack === 1);
await shot('10-new-session');

console.log('\n== 控制台错误 ==');
const realErrors = consoleErrors.filter((e) => !/Download the React DevTools/i.test(e));
ok('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | ').slice(0, 200) || 'clean');

console.log('\n========== 测试汇总 ==========');
const failed = results.filter((r) => r.status === 'FAIL');
for (const r of results) console.log(`${r.status === 'PASS' ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
await browser.close().catch(() => {});
await stopApp();
process.exit(failed.length > 0 ? 1 : 0);
