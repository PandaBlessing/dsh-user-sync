import type { ServerStorage } from './storage/types.js';

/** 反馈分区（与账号分区并列的固定目录名）。 */
const FEEDBACK_PARTITION = 'feedback';
const MAX_CONTENT = 2000;
const MAX_NOTE = 1000;
const ID_RE = /^\d{8}-\d{4}-[a-z0-9]{6}$/;
const TYPES = new Set(['design', 'feature', 'bug', 'other']);
const STATUSES = new Set(['pending', 'processing', 'done', 'rejected']);

export interface FeedbackItem {
  id: string;
  at: string;
  type: string;
  content: string;
  accountHint: string;
  pluginVersion: string;
  platform: string;
  contact: string;
  context?: Record<string, unknown>;
  status: string;
  note: string;
  handledBy: string;
  handledAt: string;
}

export interface FeedbackListResult {
  ok: true;
  total: number;
  items: Array<{
    id: string;
    at: string;
    type: string;
    accountHint: string;
    content: string;
    size: number;
    status: string;
    note: string;
    handledBy: string;
    handledAt: string;
  }>;
}

function makeId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${stamp}-${rand}`;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---- 内存限流（重启清零；不落盘 IP） ----
interface RateState {
  minuteStart: number;
  minuteCount: number;
  hourStart: number;
  hourCount: number;
}
const rateMap = new Map<string, RateState>();
const MINUTE = 60_000;
const HOUR = 3_600_000;

export function hitRateLimit(ip: string, now = Date.now()): boolean {
  const state = rateMap.get(ip) ?? { minuteStart: now, minuteCount: 0, hourStart: now, hourCount: 0 };
  if (now - state.minuteStart >= MINUTE) {
    state.minuteStart = now;
    state.minuteCount = 0;
  }
  if (now - state.hourStart >= HOUR) {
    state.hourStart = now;
    state.hourCount = 0;
  }
  state.minuteCount += 1;
  state.hourCount += 1;
  rateMap.set(ip, state);
  return state.minuteCount > 3 || state.hourCount > 20;
}

/** 从请求头拿真实客户端 IP（nginx 反代后 socket 地址恒为 127.0.0.1）。 */
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const first = (value: string | string[] | undefined): string => {
    const raw = Array.isArray(value) ? value[0] : value;
    return (raw ?? '').split(',')[0].trim();
  };
  return first(headers['x-real-ip']) || first(headers['x-forwarded-for']) || 'unknown';
}

export async function submitFeedback(
  storage: ServerStorage,
  input: { type?: unknown; content?: unknown; contact?: unknown; context?: unknown },
  meta: { accountHint?: string; pluginVersion?: string; platform?: string },
): Promise<{ ok: boolean; id?: string; error?: string; item?: FeedbackItem }> {
  const type = typeof input.type === 'string' ? input.type : 'other';
  if (!TYPES.has(type)) return { ok: false, error: 'invalid-type' };
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) return { ok: false, error: 'empty-content' };
  if (content.length > MAX_CONTENT) return { ok: false, error: 'content-too-long' };

  const item: FeedbackItem = {
    id: makeId(),
    at: new Date().toISOString(),
    type,
    content,
    accountHint: String((input.context as Record<string, unknown> | undefined)?.accountHint ?? meta.accountHint ?? '').slice(0, 6),
    pluginVersion: meta.pluginVersion ?? '',
    platform: meta.platform ?? '',
    contact: typeof input.contact === 'string' ? input.contact.slice(0, 200) : '',
    context: input.context && typeof input.context === 'object' ? (input.context as Record<string, unknown>) : {},
    status: 'pending',
    note: '',
    handledBy: '',
    handledAt: '',
  };

  try {
    await storage.put(FEEDBACK_PARTITION, item.id, Buffer.from(JSON.stringify(item, null, 2), 'utf8'));
    return { ok: true, id: item.id, item };
  } catch {
    return { ok: false, error: 'storage-error' };
  }
}

async function readAll(storage: ServerStorage): Promise<Array<{ id: string; size: number; item: FeedbackItem }>> {
  let entries: Array<{ name: string; size: number }> = [];
  try {
    entries = await storage.list(FEEDBACK_PARTITION);
  } catch {
    return [];
  }
  const results: Array<{ id: string; size: number; item: FeedbackItem }> = [];
  for (const entry of entries) {
    if (!ID_RE.test(entry.name)) continue;
    try {
      const data = await storage.get(FEEDBACK_PARTITION, entry.name);
      if (!data) continue;
      const item = JSON.parse(data.toString('utf8')) as FeedbackItem;
      results.push({ id: entry.name, size: entry.size, item });
    } catch {
      // 单条损坏跳过
    }
  }
  return results;
}

export async function listFeedback(storage: ServerStorage): Promise<FeedbackListResult> {
  const all = await readAll(storage);
  all.sort((a, b) => Date.parse(b.item.at ?? '') - Date.parse(a.item.at ?? ''));
  return {
    ok: true,
    total: all.length,
    items: all.slice(0, 500).map(({ id, size, item }) => ({
      id,
      at: item.at ?? '',
      type: item.type ?? 'other',
      accountHint: item.accountHint ?? '',
      content: (item.content ?? '').slice(0, 200),
      size,
      status: item.status ?? 'pending',
      note: (item.note ?? '').slice(0, 100),
      handledBy: item.handledBy ?? '',
      handledAt: item.handledAt ?? '',
    })),
  };
}

export async function getFeedbackFile(
  storage: ServerStorage,
  id: string,
): Promise<{ ok: boolean; item?: FeedbackItem; error?: string }> {
  if (!ID_RE.test(id)) return { ok: false, error: 'invalid-id' };
  const data = await storage.get(FEEDBACK_PARTITION, id);
  if (!data) return { ok: false, error: 'not-found' };
  try {
    return { ok: true, item: JSON.parse(data.toString('utf8')) as FeedbackItem };
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
}

export async function deleteFeedback(
  storage: ServerStorage,
  id: string,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  if (!ID_RE.test(id)) return { ok: false, deleted: 0, error: 'invalid-id' };
  const existing = await storage.get(FEEDBACK_PARTITION, id);
  if (!existing) return { ok: true, deleted: 0 };
  await storage.remove(FEEDBACK_PARTITION, id);
  return { ok: true, deleted: 1 };
}

export async function deleteFeedbackBefore(
  storage: ServerStorage,
  before: string,
): Promise<{ ok: boolean; deleted: number; failed: number; error?: string }> {
  const cutoff = Date.parse(before);
  if (!Number.isFinite(cutoff)) return { ok: false, deleted: 0, failed: 0, error: 'invalid-before' };
  const all = await readAll(storage);
  let deleted = 0;
  let failed = 0;
  for (const { id, item } of all) {
    if (Date.parse(item.at ?? '') >= cutoff) continue;
    try {
      await storage.remove(FEEDBACK_PARTITION, id);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok: true, deleted, failed };
}

export async function updateFeedbackStatus(
  storage: ServerStorage,
  id: string,
  status: string,
  note: string,
  operator: string,
): Promise<{ ok: boolean; item?: FeedbackItem; error?: string }> {
  if (!ID_RE.test(id)) return { ok: false, error: 'invalid-id' };
  if (!STATUSES.has(status)) return { ok: false, error: 'invalid-status' };
  if (note.length > MAX_NOTE) return { ok: false, error: 'note-too-long' };
  const data = await storage.get(FEEDBACK_PARTITION, id);
  if (!data) return { ok: false, error: 'not-found' };
  let item: FeedbackItem;
  try {
    item = JSON.parse(data.toString('utf8')) as FeedbackItem;
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  item.status = status;
  item.note = note;
  if (status === 'pending') {
    item.note = '';
    item.handledBy = '';
    item.handledAt = '';
  } else {
    item.handledBy = operator || 'admin';
    item.handledAt = new Date().toISOString();
  }
  await storage.put(FEEDBACK_PARTITION, id, Buffer.from(JSON.stringify(item, null, 2), 'utf8'));
  return { ok: true, item };
}

export async function feedbackStats(storage: ServerStorage): Promise<{
  ok: true;
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}> {
  const all = await readAll(storage);
  const byStatus: Record<string, number> = { pending: 0, processing: 0, done: 0, rejected: 0 };
  const byType: Record<string, number> = { design: 0, feature: 0, bug: 0, other: 0 };
  for (const { item } of all) {
    const status = STATUSES.has(item.status) ? item.status : 'pending';
    const type = TYPES.has(item.type) ? item.type : 'other';
    byStatus[status] += 1;
    byType[type] += 1;
  }
  return { ok: true, total: all.length, byStatus, byType };
}

/** 供测试使用：清空限流计数。 */
export function resetRateLimit(): void {
  rateMap.clear();
}

export { FEEDBACK_PARTITION, ID_RE, randomToken };
