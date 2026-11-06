// @deepseek-ai/schemastery 由宿主 profile 提供（运行时解析），
// 仓库不安装它；这里只给 TypeScript 提供最小类型声明。
declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = unknown> {
    (value: unknown): T;
    default(value: T): Schema<T>;
    required(): Schema<T>;
    boolean(): Schema<boolean>;
    number(): Schema<number>;
    string(): Schema<string>;
  }
  const Schema: Schema & {
    object(fields: Record<string, unknown>): Schema<Record<string, unknown>>;
    boolean(): Schema<boolean>;
    number(): Schema<number>;
    string(): Schema<string>;
    union(values: readonly unknown[]): Schema<unknown>;
  };
  export default Schema;
}
