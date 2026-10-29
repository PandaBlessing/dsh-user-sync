/** 传输层公共契约：folder 与 api 共用，sync 编排只依赖这个结构。 */

export interface PackageEntry {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface TransportTestResult {
  ok: boolean;
  detail: string;
}

export interface Transport {
  id: string;
  test(): Promise<TransportTestResult>;
  list(): Promise<PackageEntry[]>;
  meta(name: string): Promise<Record<string, unknown> | null>;
  get(name: string): Promise<Buffer>;
  put(name: string, data: Buffer): Promise<void>;
  remove(name: string): Promise<void>;
  /** 通用 POST（反馈等一次性接口）。 */
  post(path: string, body: unknown): Promise<Record<string, unknown>>;
}
