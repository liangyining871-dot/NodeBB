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

## 蓝区：构建并导出
```powershell
docker build -t nodebb-nodebb:latest .
docker save nodebb-nodebb:latest -o D:\deploy-export\nodebb.tar
```

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
docker compose -f docker-compose.production.yml config --quiet
```

## 服务器首次上线（仅执行一次）
```sh
cd /data/aixsilicon/nodebb
docker compose -f docker-compose.production.yml run --rm -e SETUP=1 nodebb
docker compose -f docker-compose.production.yml up -d nodebb
```
按提示确认正式地址 `http://aixsilicon.developers.hisilicon.com:9203`、数据库参数并填写管理员信息。配置保存在 `.docker/config/config.json`，仅首次安装执行初始化。当前本地外观会自动应用，详情见 `docs/first-deployment-appearance.md`。
当前镜像在本地安装锁定依赖、使用临时 PostgreSQL 构建当前主题及插件资源，临时数据库和配置不会带入最终镜像。内网入口不再执行 npm install，首次 setup 跳过构建；正常启动仅执行数据库迁移后启动论坛。
不要挂载 `/usr/src/app/node_modules` 或 `/usr/src/app/build`，否则会遮挡镜像内容。旧 `.docker/build` 可以保留在磁盘，但不能继续挂载。使用旧 Compose 或匿名卷的旧容器必须重建，使用本文件的 Compose。`.docker/config` 只保留运行配置，不再链接其中历史 package.json/lock 文件。
这里的离线是无需访问外网依赖源；数据库、MinIO 及启用时的 Uniportal 必须可达。其他业务功能如外部链接预览、邮件仍取决于相应服务。

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
更新完成后按“启动与检查”查看状态和日志，验证登录、页面、发帖和附件。
入口每次启动仅运行待执行的 schema 迁移；升级前必须备份，迁移失败不会继续启动。回滚镜像未必能回滚数据库，必要时恢复配套备份。
普通代码和主题资源更新使用新镜像即可；已初始化数据库的主题/插件选择不自动覆盖，切换主题或启用包时须同时规划数据库配置与镜像资源，不能只在内网后台切换后期望自动构建。

## 本地无外网验证

`test/docker-compose.offline.yml` 使用独立项目名、临时数据库和独立数据卷，网络 `internal: true`，不接入真实数据库、MinIO 或本地 `.env`。
先准备测试镜像 `nodebb-offline:validation` 以及 `postgres:16.13`、`minio/minio:latest`，测试 Compose 禁止自动拉取。

```powershell
docker build -t nodebb-offline:validation .
docker compose -f test/docker-compose.offline.yml up -d postgres minio
docker compose -f test/docker-compose.offline.yml run --rm -T -e SETUP=1 nodebb
docker compose -f test/docker-compose.offline.yml up -d nodebb
docker compose -f test/docker-compose.offline.yml cp test/offline-smoke.cjs nodebb:/tmp/offline-smoke.cjs
docker compose -f test/docker-compose.offline.yml exec -T nodebb node /tmp/offline-smoke.cjs
```

测试脚本验证实际主题/插件、资源加载、管理员登录、MinIO 读写及外网不可达。
可在 `restart nodebb` 或 `up -d --force-recreate nodebb` 后重新复制脚本并执行，确认配置与数据保留。
测试结束执行 `docker compose -f test/docker-compose.offline.yml down`；测试数据卷仅用于验证，不包含生产数据。

2026-11-12 已在本地 Docker Desktop（Linux/amd64）完成实际镜像构建，以及 internal 网络下的首次初始化、启动、管理员登录、主题/Logo/资源加载和 MinIO 读写验证；测试确认无法访问外网。重启和重建容器后再次通过，且服务器端修改的测试标题被保留。镜像未包含本地 .env、临时 config.json 或临时数据库，未声明匿名 build/node_modules 卷。
构建时 npm audit 报告现有依赖共 13 项漏洞（10 moderate、3 high）；本次未自动升级依赖，以免改变主题/插件兼容性，需另行评估修复。

