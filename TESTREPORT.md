# 测试报告

- 生成时间：2026-10-30 17:10:33
- 结果：5/5 通过

| 步骤 | 结果 | 耗时(s) | 详情 |
|---|---|---|---|
| 构建：插件 tsc | ✅ 通过 | 1.0 | ok |
| 构建：服务端 tsc | ✅ 通过 | 0.5 | ok |
| 构建：后台前端 build:prod | ✅ 通过 | 18.1 | ok |
| 测试：全量 node --test | ✅ 通过 | 8.5 | ℹ tests 193 / ℹ suites 0 / ℹ pass 192 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 1 / ℹ todo 0 / ℹ duration_ms 8309.1093 |
| 接口：10001 health + agents-export | ✅ 通过 | 0.1 | health=ok agents-export=404 |
