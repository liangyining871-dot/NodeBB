# 内网首次部署外观基线

2026-11-12 从当前本地 PostgreSQL 以只读事务核对并导出。
配置快照：`install/docker/appearance.snapshot.json`。这不是 NodeBB 自带的 setup.json 格式，由项目的首次初始化逻辑自动应用。

Dockerfile 已设置 `INITIAL_APPEARANCE_SNAPSHOT=/usr/src/app/install/docker/appearance.snapshot.json`。
使用新镜像执行原有 `SETUP=1` 初始化即可自动导入，无需手改数据库。
本地开发默认不导入；需要在专门的新数据库上验证时，可显式设置此环境变量为快照绝对路径后执行 setup。不要对当前本地数据库重新初始化。

## 当前实际配置

- NodeBB 4.16.7；主题 `nodebb-theme-lavender@8.1.2`，使用 `scripts/patch-lavender.js` 兼容补丁。
- 站点及浏览器标题：AIXSILICON广场；显示站点标题。
- 默认语言 zh-CN，关闭自动检测语言；首页 categories。
- Logo `/assets/brand/huawei-emblem-transparent.png`，替代文字 HUAWEI，链接 `/`；图片已在 `public/brand/`。
- 未设置额外 Bootswatch 皮肤；数据库未配置自定义 CSS、HTML、JS。
- 每页主题/帖子 20，每页分类 50。其余已导出的外观字段、导航顺序和小工具内容见快照。
- 启用包共 11 个（包含主题）：composer-default、lavender、dbsearch、markdown、mentions、widget-essentials、rewards-essentials、emoji、emoji-android、private-attachments、sso-uniportal；完整包名、实际安装版本及顺序在快照中。
- web-push 未启用。Uniportal 插件处于启用列表不代表企业认证环境变量已配置。
- 保留当前运行策略：activitypubEnabled、postDelay、newbiePostDelay、initialPostDelay 均为 0。

## 首次初始化应用顺序

1. 本地构建 Linux 镜像，包含上述包、Lavender 补丁、仓库内页面修改和品牌图片。
2. 内网创建全新数据库并完成 NodeBB 管理员初始化，使用服务器自己的账号、密码和会话密钥。
3. setup 在默认数据及升级步骤完成后、前端构建之前，自动应用快照中的外观配置、主题和启用包顺序、导航及小工具配置；不复制本地用户、帖子、密码或数据库连接配置。
4. 运行配置使用 `http://aixsilicon.developers.hisilicon.com:9203`、端口 9203、监听 `0.0.0.0`。MinIO 和 Uniportal 使用内网专用环境配置。
5. 发布与此快照匹配的本地预构建资源，避免旧 `.docker/build` 遮挡；内网启动不联网安装、不重新构建。
6. 验收标题、Logo、中文、导航、分类首页、发帖编辑器、表情及附件功能。

首次导入在数据库 `deployment:initial-appearance` 保存状态。导入前校验 NodeBB 和所有启用包版本；缺失或不匹配则初始化报错，不会静默下载包。
成功后状态为 complete，普通启动和升级不调用导入；重复 setup 也跳过导入，并避免默认插件和默认页脚覆盖已应用的配置。
导入失败保留 pending，修复问题后重新执行 setup 可重试。初始化期间不要并发运行多个 setup 或启动论坛。
已有主题且没有 pending 标记的旧数据库直接跳过，不会自动覆盖已有站点。
镜像构建已改为在本地使用临时 PostgreSQL 应用此快照并预构建资源；临时数据库和配置不进入最终镜像。运行入口只执行 setup（跳过构建）或 schema 迁移及启动，不安装依赖。部署 Compose 不再挂载 build 和 node_modules。内网环境的实际验收仍需执行。
分类名称、图标、颜色和排序属于分类数据，不在本外观快照中；若要求分类内容也与本地一致，后续需另外生成分类初始化清单，不复制其帖子和用户数据。

## 本地设置变更后重新导出

在项目根目录使用 Node.js 24：

```powershell
node --env-file=.env scripts/export-appearance.js
```

该命令只读数据库，覆盖快照文件。发布前检查导航、小工具和自定义 HTML 中是否含本地绝对地址或敏感信息；当前快照已人工检查。
