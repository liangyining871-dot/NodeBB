# 本地切换主题

后台选择已经安装的主题后，停止正在运行的论坛，再使用 Node.js 24 构建并启动：

```powershell
$env:Path = "D:\software\workspace\developTools\node-v24.22.2-win-x64;" + $env:Path
node --env-file=.env .\nodebb build --series
# 必须确认构建退出码为 0，且日志包含 Asset compilation successful，再启动。
node --env-file=.env .\nodebb dev
```

浏览器按 Ctrl+F5 刷新。不需要 git pull，也不需要 setup 或数据库重初始化。

Lavender 8.1.2 的部分模板仍使用旧式 `[[语言键]]`，在 NodeBB 4.16.7 中会显示原始键名。
项目通过 `scripts/patch-lavender.js` 转换为 `{{tx(...)}}`，保留翻译参数及动态状态标签。
`install/package.json` 的 postinstall 会在正常依赖安装后自动应用补丁；
若使用 `npm install --ignore-scripts`，需在构建前手工执行 `node scripts/patch-lavender.js`。
补丁限定 Lavender 8.1.2，升级主题后需要重新核对。不要只修改 `build/` 生成文件。

当前内网论坛设置 `activitypubEnabled=0`，避免对外联合发布；
发帖间隔配置 `postDelay`、`newbiePostDelay`、`initialPostDelay` 均为 0。
这些数据库设置修改后必须重启，单独重新构建模板不会刷新运行进程的配置。

若显示 `Failed to lookup view`，先检查构建是否完整成功，以及
`build/public/templates/header.tpl`、`header.js` 等模板是否存在。
构建失败时不要只看最后执行了启动命令；应先解决构建错误。
`package.json` 应保存为不带 BOM 的 UTF-8，BOM 会使 Webpack JSON 解析失败。
并行构建提前失败可能留下部分模板，修正后需重新完整构建。

当前 HTTP 本地部署停用了 `nodebb-plugin-web-push`：其 VAPID subject 使用站点地址，
HTTP 地址不符合要求。它是浏览器后台推送，停用不等于关闭论坛站内通知；
后续正式 HTTPS 部署时再评估启用。不要仅为消除警告把实际 HTTP 站点地址伪改为 HTTPS。

`/.well-known/appspecific/com.chrome.devtools.json` 的 404 是 Chrome 开发工具探测，
不是缺失论坛页面模板的原因。
