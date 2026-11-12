/**
 * pnpm-workspace.yaml 净化：清除已卸载插件留下的安装白名单条目。
 *
 * 背景：pnpm 会把装过的包写进 `minimumReleaseAgeExclude`（以及 `allowBuilds`），
 * 卸载插件时这些条目不会被自动删除。同步整文件时会把它们带到其他机器。
 * 这里只处理 `minimumReleaseAgeExclude` 段：保留 package.json dependencies
 * 中仍存在的包，其余条目删除；其他段落（allowBuilds、patchedDependencies 等）
 * 原样保留。
 */

/** 从一条列表项里取包名：支持 `a@1`、`@scope/a@1`、`a@1 || 2` 三种写法。 */
export function entryPackageName(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  text = text.replace(/\s+#.*$/, '').trim();
  if (!text) return null;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1).trim();
  }
  const first = text.split('||')[0].trim();
  if (!first) return null;
  if (first.startsWith('@')) {
    const second = first.indexOf('@', 1);
    return second === -1 ? first : first.slice(0, second);
  }
  const at = first.indexOf('@');
  return at === -1 ? first : first.slice(0, at);
}

/**
 * 净化 pnpm-workspace.yaml 文本：删除 minimumReleaseAgeExclude 中
 * 不在 dependencies 的条目。dependencies 为空时不净化（保守，避免误删）。
 */
export function sanitizePnpmWorkspace(
  text: string,
  dependencies: Record<string, string>,
): string {
  const names = Object.keys(dependencies);
  if (names.length === 0) return text;
  const deps = new Set(names);
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlock = false;
  let blockIndex = -1;
  let kept = 0;

  for (const line of lines) {
    if (!inBlock) {
      if (/^minimumReleaseAgeExclude:\s*$/.test(line)) {
        inBlock = true;
        blockIndex = out.length;
        kept = 0;
      }
      out.push(line);
      continue;
    }
    const item = /^(\s*)-\s+(.*)$/.exec(line.replace(/\r$/, ''));
    if (item) {
      const name = entryPackageName(item[2]);
      if (name === null || deps.has(name)) {
        out.push(line);
        kept += 1;
      }
      // 已卸载插件的条目：删除该行
      continue;
    }
    inBlock = false;
    if (kept === 0) {
      out[blockIndex] = 'minimumReleaseAgeExclude: []';
    }
    out.push(line);
  }
  if (inBlock && kept === 0) {
    out[blockIndex] = 'minimumReleaseAgeExclude: []';
  }
  return out.join('\n');
}
