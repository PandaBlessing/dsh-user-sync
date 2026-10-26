import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const repoRoot = join(import.meta.dirname, '..');

function walk(dir, out = []) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name === 'node_modules' || dirent.name === '.git') continue;
    const abs = join(dir, dirent.name);
    if (dirent.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

test('仓库内所有 JSON 文件无 UTF-8 BOM（宿主 JSON.parse 会因此启动失败）', () => {
  const files = walk(repoRoot).filter((file) => file.endsWith('.json'));
  assert.ok(files.length > 0, '应至少找到 package.json');
  for (const file of files) {
    const buf = readFileSync(file);
    assert.ok(
      !(buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
      `发现 BOM：${file}`,
    );
  }
});

test('仓库内所有 JSON 文件可被 JSON.parse 解析', () => {
  const files = walk(repoRoot).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')), `解析失败：${file}`);
  }
});
