# 项目约定

## npm 发布

npm 发布只做到「可发布产物 + 提示」为止，最后一步由用户执行：

1. 改版本号、构建、跑测试；
2. `npm pack` 生成 `pandablessing-dsh-user-sync-<版本>.tgz`，报告 shasum/integrity；
3. 向用户给出可直接执行的命令，例如：

   ```bash
   npm publish ./pandablessing-dsh-user-sync-1.0.36.tgz --access public --otp=<验证码>
   ```

4. 用户发布后，再做 registry 校验（`npm view @pandablessing/dsh-user-sync version`、tarball 可达）。

不要代替用户完成 2FA 或真正执行 `npm publish`。