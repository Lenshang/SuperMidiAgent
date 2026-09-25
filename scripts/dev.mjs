/** 开发模式：并行启动 vite dev server 与 electron（带远程调试端口）。 */
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

function run(cmd, args, env, label) {
  const p = spawn(cmd, args, { shell: process.platform === 'win32', env: { ...process.env, ...env }, stdio: 'inherit' });
  p.on('exit', (code) => {
    console.log(`[${label}] exited with ${code}`);
    if (label === 'electron') {
      vite.kill();
      process.exit(code ?? 0);
    }
  });
  return p;
}

const vite = run('npx', ['vite'], {}, 'vite');

// 等待 vite 就绪
await new Promise((resolve) => setTimeout(resolve, 3500));

const electron = run(electronBin as unknown as string, ['.', '--remote-debugging-port=9222'], { SUPERMIDI_DEV: '1' }, 'electron');
void electron;
