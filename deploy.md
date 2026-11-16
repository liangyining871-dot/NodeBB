# 本文件仅做运行及部署介绍，，不涉及这两项时不要随意修改 

# 蓝区本地运行（nodebb要求Node.js版本与蓝区本机不一致，额外下了一个对应版本）
$env:Path = "D:\software\workspace\developTools\node-v24.22.2-win-x64;" + $env:Path #切换nodejs版本
node --env-file=.env .\nodebb setup --dev #首次初始化
node --env-file=.env .\nodebb dev #正常启动

## Windows 本地：修改页面或切换主题后
```powershell
node --env-file=.env .\nodebb build --series #重新build命令
node --env-file=.env .\nodebb dev #再次启动
```

## 蓝区：构建镜像并导出

部署前先更新快照并检查，使用上面的 Node.js 24 路径。外观快照只包含主题、插件、导航、外观和上传策略，
不包含帖子、用户、版块结构、版块的摘要数量设置、PostgreSQL 数据和 MinIO 对象；需要迁移内容时单独备份恢复。
当前上传上限仍为 2048 KB（2 MB）；视频较大时需在管理后台调整上限，再重新导出快照。
首次初始化自动应用镜像里的快照，已有生产数据库升级不会覆盖原有设置。

```powershell
node --env-file=.env scripts/export-appearance.js
node --env-file=.env .\nodebb build --series
node scripts/check-deployment.js --compose
```

上传白名单应包含 MP4、WMV、WebM、OGG。已有站点若需要补齐白名单，可先停止论坛，
运行 `node --env-file=.env scripts/configure-posting.js --apply`，再导出快照；该命令会备份原设置，
同时沿用本项目既定策略：关闭发帖审核、允许注册用户上传文件，不改变大小上限。

镜像内包含 FFmpeg，构建会自动验证真实 WMV 转 MP4、封面提取及首页媒体预览资源；
Windows 的 `.env`、`config.json`、本地测试账户文件和上传文件不会打进镜像。

```powershell
docker build -t nodebb-nodebb:latest .
docker save nodebb-nodebb:latest -o D:\deploy-export\nodebb.tar
Get-FileHash D:\deploy-export\nodebb.tar -Algorithm SHA256
```

构建和导出应都成功后再传输。保存上一个发布镜像及其对应的数据库、MinIO、配置备份用于回退，
不要把仅含外观设置的快照当成整站备份。

## 黄区：服务器目录
建议使用 `/data/aixsilicon/nodebb`：

```text
/data/aixsilicon/nodebb/
├── docker_images/nodebb.tar
├── docker-compose.production.yml # 服务器专用；连接信息直接填写在 environment
├── .docker/
│   ├── config/                 # 运行配置及会话密钥，升级时保留
│   └── public/uploads/         # 上传文件，升级时保留
└── backups/                    # 配置、上传文件及数据库备份
```

准备目录及容器用户权限：
```sh
sudo mkdir -p /data/aixsilicon/nodebb
cd /data/aixsilicon/nodebb
sudo mkdir -p docker_images .docker/config .docker/public/uploads backups
sudo chown -R 1001:1001 .docker
```

将文件放到上述位置后，加载镜像：
```sh
docker load -i docker_images/nodebb.tar
```

传输后核对 SHA-256 与蓝区一致，再启动；可在不连接生产数据库的情况下检查镜像：
```sh
sha256sum docker_images/nodebb.tar
docker compose -f docker-compose.production.yml config --quiet
docker compose -f docker-compose.production.yml run --rm --no-deps --entrypoint node nodebb scripts/check-deployment.js --image
```

上线前核对 Compose 中的域名、企业登录回调、PostgreSQL 和 MinIO 连接信息；生产容器使用
`FFMPEG_PATH=/usr/bin/ffmpeg`。不要挂载本地 `build/`、`node_modules/` 或 Windows `.env`。
确认服务器架构与镜像匹配，且容器能访问 PostgreSQL、MinIO 和企业登录接口。

## 服务器首次上线（仅执行一次）
```sh
cd /data/aixsilicon/nodebb
docker compose -f docker-compose.production.yml run --rm -e SETUP=1 nodebb #首次初始化
docker compose -f docker-compose.production.yml up -d nodebb #启动
```

## 启动与检查
```sh
cd /data/aixsilicon/nodebb
docker compose -f docker-compose.production.yml up -d nodebb
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs -f --tail 100 nodebb
```
访问 `http://aixsilicon.developers.hisilicon.com:9203/`，管理后台为 `/admin`。确保域名指向服务器且允许访问 9203 端口。健康检查仅确认 HTTP 响应，不能代替登录、附件上传等功能验收；unhealthy 状态不会自动触发 Docker 重启。

## 服务器后续更新（不再 setup）
先在部署目录执行 `docker compose -f docker-compose.production.yml stop nodebb`，再备份 PostgreSQL、MinIO 对象、`.docker/config` 和 `.docker/public/uploads`。替换 `docker_images/nodebb.tar`；仅配置变化时同步 Compose，并保留生产连接信息。然后执行：
```sh
docker load -i docker_images/nodebb.tar
docker compose -f docker-compose.production.yml up -d --force-recreate nodebb
```
更新时保留 `.docker`，不要重新执行首次初始化。

已有站点的白名单不会随镜像更新。需要补齐 WMV 等格式时，停服备份后执行以下一次性配置命令，
它也会关闭发帖审核、允许注册用户上传文件，上传大小上限保持不变：
```sh
docker compose -f docker-compose.production.yml run --rm --no-deps --entrypoint node nodebb scripts/configure-posting.js --apply
```

升级启动会执行数据库迁移，因此回退不应只更换旧镜像；需要按同一备份时间点恢复数据库、
MinIO 对象及 `.docker/config`。不要执行 `docker compose down -v` 删除持久数据。

## 上线验收

- 验证首页、企业登录和登录超时；后台 `/login?local=1` 的本地管理入口仍可使用。
- 验证图片上传、首页图片缩略图、MP4 点击封面直接播放、拖动进度，以及 WMV 首次转换和后续复用。
- 验证首页视频封面、刷新后复用，以及无权限用户不能读取图片、封面、原视频或 Range 分段。
- 大视频首次转换可能耗时，反向代理的读取超时应覆盖转换等待（当前转换超时为十分钟），
  代理应透传 Range/Content-Range；上传体积限制应与论坛配置匹配。

# 重启
docker compose -f docker-compose.production.yml restart nodebb


