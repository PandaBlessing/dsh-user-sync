// 用例覆盖审计：对照 docs/test-cases.md 与 docs/test-results/ 的记录。
// 用法：node scripts/audit-cases.mjs
import fs from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const casesPath = join(root, 'docs', 'test-cases.md');
const resultsDir = join(root, 'docs', 'test-results');

const caseIds = [...fs.readFileSync(casesPath, 'utf8').matchAll(/^\|\s*([A-Z0-9]+-\d{2})\s*\|/gm)].map((m) => m[1]);

const resultIds = new Set();
for (const file of fs.readdirSync(resultsDir)) {
  if (!file.endsWith('.md')) continue;
  const text = fs.readFileSync(join(resultsDir, file), 'utf8');
  for (const match of text.matchAll(/^\|\s*([A-Z0-9]+-\d{2})[^|]*\|/gm)) resultIds.add(match[1]);
}

const missing = caseIds.filter((id) => !resultIds.has(id));
const extra = [...resultIds].filter((id) => !caseIds.includes(id));

console.log(`用例总数: ${caseIds.length}，已记录: ${resultIds.size}`);
console.log(`未记录: ${missing.length}${missing.length ? ` -> ${missing.join(', ')}` : ''}`);
console.log(`记录中但清单没有: ${extra.length}${extra.length ? ` -> ${extra.join(', ')}` : ''}`);
process.exit(missing.length === 0 && extra.length === 0 ? 0 : 1);
