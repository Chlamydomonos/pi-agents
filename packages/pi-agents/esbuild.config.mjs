// pi-agents 插件构建(docs/70 §1,docs/60 §3):
// pi 扩展本体(src/extension)由宿主 jiti 直载 TS,**不构建**;
// 只有 pi-web 插件两端必须打包(宿主不编译插件源码):
//   - server bundle:平台 node;pi-web 是宿主运行时依赖,external(与 pi-comfyui 同模式)
//   - browser bundle:单文件 ESM;lit 打进 bundle;pi-web 仅类型,构建期擦除
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: false, // 包体积上限 16MiB/4096 文件,不进 source map
    legalComments: 'none',
    logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const server = {
    ...common,
    entryPoints: ['src/plugin/server/index.ts'],
    platform: 'node',
    outfile: 'dist/plugin/server/index.js',
    packages: 'external',
    external: ['@jmfederico/pi-web'],
};

/** @type {import('esbuild').BuildOptions} */
const browser = {
    ...common,
    entryPoints: ['src/plugin/browser/index.ts'],
    platform: 'browser',
    outfile: 'dist/plugin/browser/index.js',
};

if (watch) {
    const ctxs = await Promise.all([esbuild.context(server), esbuild.context(browser)]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[pi-agents] watching…');
} else {
    await Promise.all([esbuild.build(server), esbuild.build(browser)]);
}
