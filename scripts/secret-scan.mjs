/** 密钥泄漏扫描：在源码中查找疑似 API Key 模式，发现即失败（CI 防线）。 */
import fs from 'fs';
import path from 'path';

const PATTERNS = [
  { name: 'OpenAI 风格 API Key', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: 'Bearer 长令牌', re: /Bearer\s+[A-Za-z0-9._-]{32,}/g },
];

const SKIP = new Set(['node_modules', '.git', 'dist', 'release', 'tmp', '.tools', 'build', '.zcode']);

const hits = [];
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
    } else if (e.name.match(/\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|html|css|txt|npmrc)$/i) || e.name === '.npmrc') {
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      for (const { name, re } of PATTERNS) {
        const m = text.match(re);
        if (m) hits.push(`${p}  [${name}]  ${m[0].slice(0, 10)}…`);
      }
    }
  }
}

walk('.');

if (hits.length > 0) {
  console.error('发现疑似 API 密钥泄漏（请改为环境变量提供）：');
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log('secret scan OK：未发现疑似密钥');
