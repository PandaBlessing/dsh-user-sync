import type { FeedbackItem } from './feedback.js';

/** 飞书应用配置（只在服务端 secrets.json 中配置，不进仓库）。 */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  chatIds: string[];
}

interface TokenCache {
  token: string;
  expireAt: number;
}

let cache: TokenCache | null = null;

const TYPES: Record<string, string> = {
  design: '设计建议',
  feature: '功能建议',
  bug: '问题',
  other: '其他',
};

async function tenantToken(config: FeishuConfig): Promise<string | null> {
  if (cache && Date.now() < cache.expireAt - 60_000) return cache.token;
  try {
    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as { code?: number; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) return null;
    cache = { token: data.tenant_access_token, expireAt: Date.now() + (data.expire ?? 7200) * 1000 };
    return cache.token;
  } catch {
    return null;
  }
}

export function buildCard(item: FeedbackItem): string {
  const typeLabel = TYPES[item.type] ?? item.type;
  const statusLabel: Record<string, string> = { pending: '待处理', processing: '处理中', done: '已完成', rejected: '已拒绝' };
  const time = new Date(item.at).toLocaleString('zh-CN', { hour12: false });
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**编号**\n${item.id}\n**账号**\n${item.accountHint || '（未配对）'}\n**版本**\n${item.pluginVersion || '-'} / ${item.platform || '-'}\n**时间**\n${time}\n**状态**\n${statusLabel[item.status] ?? item.status}` },
    { tag: 'hr' },
    { tag: 'markdown', content: item.content },
  ];
  if (item.status === 'pending' || item.status === 'processing') {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '标记已完成' }, type: 'primary', behaviors: [{ type: 'callback', value: { action: 'done', id: item.id } }] });
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '标记已拒绝' }, type: 'danger', behaviors: [{ type: 'callback', value: { action: 'rejected', id: item.id } }] });
  } else {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '重新打开' }, type: 'default', behaviors: [{ type: 'callback', value: { action: 'pending', id: item.id } }] });
  }
  elements.push({ tag: 'button', text: { tag: 'plain_text', content: '去后台' }, type: 'default', behaviors: [{ type: 'open_url', default_url: 'https://dsh-admin.wenzhi.info/feedback/list' }] });
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `收到新反馈（${typeLabel}）` } },
    body: { elements },
  };
  return JSON.stringify(card);
}

/** 新反馈通知到飞书群（失败只记日志，不影响提交）。 */
export async function notifyNewFeedback(item: FeedbackItem, config: FeishuConfig | null): Promise<void> {
  if (!config || !config.chatIds?.length || !config.appId || !config.appSecret) return;
  const token = await tenantToken(config);
  if (!token) {
    console.warn('[dsh-user-sync] feishu notify: token 获取失败');
    return;
  }
  const content = buildCard(item);
  for (const chatId of config.chatIds) {
    try {
      const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        console.warn(`[dsh-user-sync] feishu notify 失败: ${response.status} ${detail.slice(0, 200)}`);
      }
    } catch (error) {
      console.warn('[dsh-user-sync] feishu notify 异常:', (error as Error).message);
    }
  }
}
