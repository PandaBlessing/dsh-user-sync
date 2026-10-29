# 用户反馈功能 · 测试用例清单

> 对应设计：[feedback-design.md](feedback-design.md)
> 状态：待实现（清单先定）

## 服务端（提交接口）

- [ ] FE-01 正常提交 → 200 `{ok:true,id}`，坚果云出现 `feedback/<id>.json`
- [ ] FE-02 空内容 → 400
- [ ] FE-03 内容超 2000 字 → 400
- [ ] FE-04 非法 type（如 `xxx`）→ 400
- [ ] FE-05 请求体过大（>16KB）→ 413/400
- [ ] FE-06 同 IP 每分钟第 4 条 → 429
- [ ] FE-07 写入失败（存储不可用）→ 500，进程不崩溃
- [ ] FE-08 并发提交 10 条 → 各自独立文件，不覆盖（id 不重复）
- [ ] FE-09 经 nginx 反代提交（x-real-ip 不同）→ 不同 IP 各自独立限流，不互相影响

## 服务端（查询）

- [ ] FE-10 无 adminKey → 401
- [ ] FE-11 有 adminKey → 200，items 按时间倒序
- [ ] FE-12 列表为空 → `{ok:true, total:0, items:[]}`
- [ ] FE-12b 列表返回 `total` 与实际条数一致
- [ ] FE-13 单条详情 → 200 完整 JSON（含 status/note/handledBy/handledAt）
- [ ] FE-14 不存在的 id → 404
- [ ] FE-15 非法 id（含 `../` 等）→ 400（防路径穿越）

## 服务端（单条删除 `POST .../delete`）

- [ ] FE-19 `{id}` 删除单条 → `{ok:true, deleted:1}`，其他条目不受影响
- [ ] FE-19b id 不存在 → `{ok:true, deleted:0}`
- [ ] FE-19c id 含 `../` 等非法字符 → 400
- [ ] FE-19d 缺 id → 400

## 服务端（批量清理 `POST .../delete-before`）

- [ ] FE-16 `{before}` 删除该时间前的反馈 → `{ok:true, deleted:N}`，列表不再返回这些条目
- [ ] FE-17 `before` 非法（如 `abc`）→ 400
- [ ] FE-18 删除时部分文件失败 → `failed:M`，已删的不回滚，进程不崩溃

## 服务端（处理 `POST .../status`）

- [ ] FE-23 `{id,status:'done',note,operator}` → 200，JSON 里 status/note/handledBy/handledAt 更新
- [ ] FE-24 非法 status（如 `xxx`）→ 400
- [ ] FE-25 note 超 1000 字 → 400
- [ ] FE-26 不存在的 id → 404
- [ ] FE-27 将状态改回 pending 且清空 note → 200
- [ ] FE-28 处理意见写回反馈 JSON（坚果云 feedback/<id>.json 内可见 note/handledBy/handledAt）
- [ ] FE-29 `GET .../feedback/stats` → total 与 byStatus/byType 计数正确
- [ ] FE-29b stats 无 adminKey → 401

## 存储

- [ ] FE-20 `list('feedback')` 返回全部条目（PROPFIND 解析正确，含 URL 编码的中文）
- [ ] FE-21 中文/大文件内容写入后读回一致
- [ ] FE-22 `remove` 后 `list` 不再包含该条目

## 插件面板

- [ ] FE-30 「自动检查」卡片标题右侧出现「反馈」按钮
- [ ] FE-31 打开弹窗、选类型、输入内容、提交成功提示，**弹窗显示反馈编号**
- [ ] FE-31b 关闭弹窗后重新打开，草稿（localStorage）自动恢复；提交成功后草稿清空
- [ ] FE-31c 上传/同步失败的错误卡出现「反馈此问题」按钮，点击打开反馈弹窗并预填类型与错误摘要
- [ ] FE-32 提交失败显示服务端原因，弹窗保留输入可重试
- [ ] FE-33 内容为空时「提交」禁用
- [ ] FE-34 离线/接口不可用不影响上传、同步、自动检查等现有功能
- [ ] FE-35 窄屏下「自动检查」标题与反馈按钮不重叠
- [ ] FE-36 未同意/未配对账号时入口仍可用（accountHint 为空）
- [ ] FE-37 弹窗含「勿填敏感信息」提示
- [ ] FE-38 提交中按钮显示「提交中…」且禁用，防重复提交
