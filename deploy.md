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

首次部署时提前创建上述目录，确保 `.docker` 下的目录可由容器用户 UID/GID `1001:1001` 写入。
已有站点保留原数据库、MinIO、`.docker/config` 和 `.docker/public/uploads`，替换镜像文件；配置有变化时同步 Compose。

## 黄区：加载镜像并启动（已有站点更新）

```sh
cd /data/aixsilicon/nodebb

docker load -i docker_images/nodebb.tar

docker compose -f docker-compose.production.yml up -d --no-deps --force-recreate nodebb
```

## 黄区：首次初始化（仅空数据库执行一次）

首次部署需在加载镜像后、启动容器前执行以下命令；已有站点更新跳过此步骤。

```sh
docker compose -f docker-compose.production.yml run --rm --no-deps -e SETUP=1 nodebb
```
