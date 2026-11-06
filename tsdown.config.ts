/**
 * Browser client bundle，对齐 DeepSeek Harness 的 client preset：
 * 产出 window.__ModuleLoader__.load({ id, factory }) 的闭包工厂产物，
 * externals 从 loader 模块表解析（react）。
 *
 * 与 tsc 产出的 lib/ 不同：lib/ 是 host 侧（Node ESM），client/ 是浏览器侧。
 */
import { defineConfig } from 'tsdown';

const id = '@pandablessing/dsh-user-sync';
const CLIENT_EXTERNALS = ['react'];

export default defineConfig({
  entry: { client: 'src/client.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
  },
});
