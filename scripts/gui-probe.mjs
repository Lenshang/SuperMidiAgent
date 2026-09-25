/** GUI 探测：连接 CDP，检查页面加载与控制台错误。 */
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
console.log('contexts:', contexts.length);
const page = contexts[0]?.pages()[0] ?? (await browser.contexts()[0].newPage());
console.log('url:', page.url());
console.log('title:', await page.title());

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.waitForTimeout(2500);
await page.screenshot({ path: 'tmp/gui-probe.png' });

const hasRoot = await page.evaluate(() => !!document.querySelector('#root'));
const rootChildren = await page.evaluate(() => document.querySelector('#root')?.children.length ?? 0);
const apiExists = await page.evaluate(() => typeof window.api === 'object' && typeof window.api.agentRun === 'function');
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));

console.log('root:', hasRoot, 'children:', rootChildren, 'api:', apiExists);
console.log('body text:', JSON.stringify(bodyText));
console.log('console errors:', errors.length ? errors.slice(0, 10) : 'none');
await browser.close();
