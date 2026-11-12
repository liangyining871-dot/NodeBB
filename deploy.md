# 本文件仅做运行及部署介绍，，不涉及这两项时不要随意修改 

# 蓝区本地运行（nodebb要求Node.js版本与本机不一致，额外下了一个对应版本）
# 1. 当前终端切换到 Node.js 24
$env:Path = "D:\software\workspace\developTools\node-v24.22.2-win-x64;" + $env:Path
# 2. 进入项目
cd D:\software\workspace\code\ai\nodebb1111\NodeBB
# 3. 首次初始化，按提示确认配置并填写管理员信息
node --env-file=.env .\nodebb setup --dev
# 4. 初始化成功后启动
node --env-file=.env .\nodebb dev

# NodeBB 构建部署
使用 `docker-compose-pgsql.yml`，一个容器、一个 NodeBB 工作进程，端口 `9203`。连接现有 PostgreSQL 16 的独立 `nodebb` 数据库，不另外部署数据库。
注意：当前 Compose 仍声明了 PostgreSQL 和可选 Redis 服务，以下命令通过指定 `nodebb` 和 `--no-deps` 只运行论坛。不要直接执行不带服务名的 `up`。

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
├── docker-compose-pgsql.yml
├── install/docker/setup.json
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
docker compose -p nodebb -f docker-compose-pgsql.yml config --quiet
```

## 首次初始化
先在现有 PostgreSQL 16 中创建独立账号和其拥有的 `nodebb` 数据库，并允许容器网络连接。容器中的 `127.0.0.1` 不是宿主机，应填写容器可访问的数据库服务器 IP 或域名。
```sh
docker compose -p nodebb -f docker-compose-pgsql.yml run --rm --no-deps -e SETUP=1 nodebb
```
按提示填写正式访问地址（例如 `http://服务器IP:9203`）、数据库类型 `postgres`、现有数据库地址、端口、账号密码、库名、SSL 及管理员信息。不要沿用示例中的 `postgres` 主机名和默认密码。配置保存在 `.docker/config/config.json`，仅首次安装执行初始化。
当前官方容器入口会执行 `npm install`，首次初始化及配置升级还会构建资源，因此服务器需要可访问相应依赖源；完全离线部署需要另行调整镜像和启动入口。

## 启动与检查
```sh
cd /data/aixsilicon/nodebb
docker compose -p nodebb -f docker-compose-pgsql.yml up -d --no-build --no-deps nodebb
docker compose -p nodebb -f docker-compose-pgsql.yml ps
docker compose -p nodebb -f docker-compose-pgsql.yml logs -f --tail 100 nodebb
```
访问 `http://服务器IP:9203`，管理后台为 `/admin`。确保服务器允许访问 9203 端口。

## 更新镜像
先备份 PostgreSQL 数据库及 `.docker/config`、`.docker/public/uploads`，再上传新镜像包并执行：
```sh
docker load -i docker_images/nodebb.tar
docker compose -p nodebb -f docker-compose-pgsql.yml up -d --no-build --no-deps --force-recreate nodebb
```
更新时保留 `.docker`，不要重新执行首次初始化。

