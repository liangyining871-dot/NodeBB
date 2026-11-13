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
```

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

# 重启
docker compose -f docker-compose.production.yml restart nodebb


