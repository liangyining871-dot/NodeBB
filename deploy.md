# 本文件仅做运行及部署介绍，，不涉及这两项时不要随意修改 

# 蓝区本地运行（nodebb要求Node.js版本与本机不一致，额外下了一个对应版本）
# 当前终端切换到 Node.js 24
$env:Path = "D:\software\workspace\developTools\node-v24.22.2-win-x64;" + $env:Path
# 首次初始化，按提示确认配置并填写管理员信息
node --env-file=.env .\nodebb setup --dev
# 初始化成功后启动
node --env-file=.env .\nodebb dev

# 需要修改主题的情况：目前可在管理员页面中修改，然后重新Build，为防止黄区网络问题导致Build失败。需在蓝区的镜像中准备好对应资源，黄区使用的对应数据库中，需要制定蓝区构建奖项是对应的主题；

## 蓝区：构建并导出
固定项目名为 `nodebb`，Compose 生成的镜像名为 `nodebb-nodebb:latest`：
```powershell
cd D:\software\workspace\code\ai\nodebb1111\NodeBB
docker compose -p nodebb -f docker-compose-pgsql.yml build --no-cache nodebb
docker save nodebb-nodebb:latest -o D:\deploy-export\nodebb.tar
```

## 黄区：服务器目录
建议使用 `/data/aixsilicon/nodebb`：

```text
/data/aixsilicon/nodebb/
├── docker_images/nodebb.tar
├── docker-compose.production.yml # 服务器专用；连接信息直接填写在 environment
├── .docker/
│   ├── config/                 # 运行配置、密钥及依赖清单，升级时保留
│   ├── build/                  # 前端构建产物
│   └── public/uploads/         # 上传文件，升级时保留
└── backups/                    # 配置、上传文件及数据库备份
```

准备目录及容器用户权限：
```sh
sudo mkdir -p /data/aixsilicon/nodebb
cd /data/aixsilicon/nodebb
sudo mkdir -p docker_images install/docker .docker/config .docker/build .docker/public/uploads backups
sudo chown -R 1001:1001 .docker
```

将文件放到上述位置后，加载镜像：
```sh
docker load -i docker_images/nodebb.tar
docker compose -p nodebb -f docker-compose.production.yml config --quiet
```

## 首次初始化
服务器使用 `docker-compose.production.yml`，本地构建继续使用 `docker-compose-pgsql.yml`。
服务器不需要本地 `.env`、源码或额外的 `install/docker/setup.json`；外观快照已包含在新镜像内。
Compose 已参考 ChipDocument 配置补全共用 PostgreSQL（宿主机 9010）、MinIO（宿主机 9016）和 Uniportal 的连接参数；Linux 通过 `host.docker.internal:host-gateway` 访问宿主机。需确认 NodeBB 与这些服务部署在同一台宿主机，否则修改对应地址。
NodeBB 使用独立数据库 `nodebb`（先创建并由配置账号拥有），以及独立私有桶 `nodebb-attachments`，不复用 ChipDocument 的库和桶。数据库 SSL 当前按参考连接设为 false，需确认服务端要求；MinIO region 按需填写。
Uniportal 地址、客户端信息及 scope 已参考补齐，默认仍关闭；确认客户端可供 NodeBB 使用，并批准 9203 端口的正式回调地址后再启用。
含密码的服务器 Compose 应限制权限（如 `chmod 600 docker-compose.production.yml`），不要将已填入生产凭据的文件提交仓库。YAML 字符串中的字面量 `$` 需要写成 `$$`，避免 Compose 插值。
`config --quiet` 只验证 Compose 格式，不会验证空值、数据库或 MinIO 连通性。

先在现有 PostgreSQL 16 中创建独立账号和其拥有的 `nodebb` 数据库，并允许容器网络连接。容器中的 `127.0.0.1` 不是宿主机，应填写容器可访问的数据库服务器 IP 或域名。
```sh
docker compose -p nodebb -f docker-compose.production.yml run --rm --no-deps -e SETUP=1 nodebb
```
按提示确认正式地址 `http://aixsilicon.developers.hisilicon.com:9203`、数据库参数并填写管理员信息。配置保存在 `.docker/config/config.json`，仅首次安装执行初始化。当前本地外观会自动应用，详情见 `docs/first-deployment-appearance.md`。
当前官方容器入口会执行 `npm install`，首次初始化及配置升级还会构建资源，因此服务器需要可访问相应依赖源；完全离线部署需要另行调整镜像和启动入口。

## 启动与检查
```sh
cd /data/aixsilicon/nodebb
docker compose -p nodebb -f docker-compose.production.yml up -d --no-build --no-deps nodebb
docker compose -p nodebb -f docker-compose.production.yml ps
docker compose -p nodebb -f docker-compose.production.yml logs -f --tail 100 nodebb
```
访问 `http://aixsilicon.developers.hisilicon.com:9203/`，管理后台为 `/admin`。确保域名指向服务器且允许访问 9203 端口。健康检查仅确认 HTTP 响应，不能代替登录、附件上传等功能验收；unhealthy 状态不会自动触发 Docker 重启。

## 更新镜像
先备份 PostgreSQL 数据库及 `.docker/config`、`.docker/public/uploads`，再上传新镜像包并执行：
```sh
docker load -i docker_images/nodebb.tar
docker compose -p nodebb -f docker-compose.production.yml up -d --no-build --no-deps --force-recreate nodebb
```
更新时保留 `.docker`，不要重新执行首次初始化。

