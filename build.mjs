/** esbuild 构建主进程与 preload。 */
import { build } from 'esbuild';

const nodeEnv = { 'process.env.NODE_ENV': '"production"' };

await Promise.all([
  build({
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    define: nodeEnv,
    packages: 'external',
    logLevel: 'info',
  }),
  build({
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/main/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    define: nodeEnv,
    external: ['electron'],
    logLevel: 'info',
  }),
]);

console.log('build:main 完成');
