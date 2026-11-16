# 本文件仅做运行及部署介绍，不涉及这两项时不要随意修改

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

当前布局初版使用 `recent` 作为默认首页：顶部按用户权限动态展示板块，下面复用主题列表和媒体预览。
已有站点需要切换默认首页时，停服后执行 `node --env-file=.env scripts/configure-topic-home.js --apply`，
该命令只修改 `homePageRoute` 并备份原值；不改主题数据和板块权限。修改后重新导出快照、构建并重启。

```powershell
node --env-file=.env scripts/export-appearance.js
node --env-file=.env .\nodebb build --series
node scripts/check-deployment.js --compose
```

```powershell
docker build -t nodebb-nodebb:latest .
docker save nodebb-nodebb:latest -o D:\deploy-export\nodebb.tar
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


## 服务器后续更新（不再 setup）
先在部署目录执行 `docker compose -f docker-compose.production.yml stop nodebb`，再备份 PostgreSQL、MinIO 对象、`.docker/config` 和 `.docker/public/uploads`。替换 `docker_images/nodebb.tar`；仅配置变化时同步 Compose，并保留生产连接信息。然后执行：
```sh
docker load -i docker_images/nodebb.tar
docker compose -f docker-compose.production.yml up -d --force-recreate nodebb
```

```sh
docker compose -f docker-compose.production.yml run --rm --no-deps --entrypoint node nodebb scripts/configure-posting.js --apply --max-file-size-kb=102400
```
# 重启
docker compose -f docker-compose.production.yml restart nodebb


