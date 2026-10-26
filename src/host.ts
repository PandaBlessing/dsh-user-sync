/**
 * 宿主服务最小接口：只声明本插件实际用到的成员。
 * 宿主（DSH）提供这些服务，结构以宿主为准；这里给插件侧一个可检查的契约。
 */

export interface HostRoute {
  path: string;
  methods: string[];
  requestBody: 'buffered' | 'streaming';
  fetch: (request: Request) => Response | Promise<Response>;
}

export interface ConnectionLike {
  fetch: { register: (route: HostRoute) => () => void };
}

export interface PluginManagerBundle {
  name: string;
  installed: boolean;
}

export interface PluginManagerLike {
  listBundles: () => Promise<PluginManagerBundle[]>;
  installBundle: (spec: string) => Promise<unknown>;
}

export interface ConfigEditorEntry {
  options?: { id?: string };
}

export interface ConfigEditorLike {
  entries: () => ConfigEditorEntry[];
}

export interface AccountProfile {
  status?: string;
  value?: { id?: string | null } | null;
}

export interface DeepseekAccountLike {
  getProfile: (options: { version: string; locale: string; timezoneOffsetSeconds: number }) => Promise<AccountProfile | null>;
}

/** 面板配置写入的请求体；字段逐个校验，未通过校验的字段忽略。 */
export interface ConfigBody {
  modules?: unknown;
  transport?: unknown;
  baseUrl?: unknown;
  autoCheck?: unknown;
  intervalHours?: unknown;
  confirmNonUserLevel?: unknown;
}

export interface ConsentBody {
  accepted?: boolean;
}

export interface InstallBody {
  packages?: unknown;
}

export interface ApplyBody {
  name?: unknown;
}

export interface CheckPayload {
  decision?: { action?: string | null; reason?: string | null } | null;
  latest?: { name?: string | null; modifiedAt?: string | null } | null;
  meta?: Record<string, unknown> | null;
  plan?: unknown;
  plugins?: unknown;
  [key: string]: unknown;
}
