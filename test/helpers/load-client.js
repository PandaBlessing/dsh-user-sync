import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
/** bundle 注册 id 必须与 npm 包名一致（module-loader 契约，见 design §9.1）。 */
export const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;

/**
 * 在 Node 里执行构建产物 lib/client.js（含 TS 注解不能直接 new Function 源码），
 * 注入 window.__ModuleLoader__ 与自定义 React。
 * loaderImpl 可替换 loader，用于模拟重复注册等宿主行为。
 */
export function loadClientBundle(ReactImpl, { loaderImpl } = {}) {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  let exported;
  const fakeWindow = {
    __ModuleLoader__: loaderImpl ?? {
      load({ id, factory }) {
        const module = { exports: {} };
        const require = (name) => {
          if (name === 'react') return ReactImpl;
          throw new Error(`unexpected require: ${name}`);
        };
        exported = factory(require);
        if (id !== PACKAGE_NAME) throw new Error(`bundle id 必须是包名，实际: ${id}`);
      },
    },
  };
  new Function('window', source)(fakeWindow);
  return exported;
}
