/** 服务端存储抽象：本地磁盘与 WebDAV 共用。 */

export interface StorageTestResult {
  ok: boolean;
  detail: string;
}

export interface ServerStorage {
  id: string;
  test(): Promise<StorageTestResult>;
  put(accountKey: string, id: string, data: Buffer): Promise<void>;
  get(accountKey: string, id: string): Promise<Buffer | null>;
  remove(accountKey: string, id: string): Promise<void>;
  /** 列出某分区（目录）下的条目名称；目录不存在返回空数组。 */
  list(accountKey: string): Promise<Array<{ name: string; size: number }>>;
}
