# 大视频分片直传

默认关闭。开启后，默认编辑器选文件、拖拽和粘贴中的 MP4、WMV、WebM、OGG 视频达到 16 MiB 时，改为浏览器直接分片上传到 MinIO。支持单文件最多 2 GiB（2147483648 字节），默认每片 16 MiB、并发 3 片，失败最多重试 3 次，每次重取短期签名。

普通图片、文档、小视频继续使用原来的上传入口和大小限制。同批混选视频与普通文件时分别处理，附件顺序和编辑器占位符保持一致。不需要将 NodeBB 的普通附件大小上限改成 2 GiB。

上传期间显示进度、速度、预计剩余时间和取消按钮；上传中离开页面会触发浏览器确认。第一版不恢复刷新或关闭页面后的任务；页面保持打开时可重试失败分片。电脑休眠、浏览器冻结或长期断网仍可能中断上传。

## 本地环境

本地 `.env` 已配置：

```dotenv
MINIO_DIRECT_UPLOAD_ENABLED=true
MINIO_PUBLIC_URL=http://127.0.0.1:9000
MINIO_DIRECT_UPLOAD_MAX_BYTES=2147483648
MINIO_DIRECT_UPLOAD_PART_SIZE_MB=16
```

内部连接沿用本地现有的 `MINIO_ENDPOINT=127.0.0.1` 和 `MINIO_PORT=9000`。构建后重启本地 NodeBB，并强制刷新浏览器；后端进程需要重新读取 `.env`。

编辑器兼容补丁由 `scripts/patch-composer.js` 提供并在安装后自动应用，固定检查 Composer 11.0.16。若使用已有依赖目录，可手动执行：

```powershell
node scripts/patch-composer.js
node --env-file=.env nodebb build --series
```

## 服务器 Compose 变量

`docker-compose.production.yml` 中已经添加以下四个变量。可在服务器 Compose 使用的 `.env` 设置，或直接填写 `services.nodebb.environment` 的值：

```dotenv
MINIO_DIRECT_UPLOAD_ENABLED=true
MINIO_PUBLIC_URL=http://你的服务器域名或IP:9016
MINIO_DIRECT_UPLOAD_MAX_BYTES=2147483648
MINIO_DIRECT_UPLOAD_PART_SIZE_MB=16
```

| 变量 | 含义 |
| --- | --- |
| `MINIO_DIRECT_UPLOAD_ENABLED` | `true` 开启视频直传，`false` 回到原流程 |
| `MINIO_PUBLIC_URL` | **用户浏览器能访问的 MinIO S3 API 根地址**，不是管理控制台；不带桶名、路径前缀或账号密码 |
| `MINIO_DIRECT_UPLOAD_MAX_BYTES` | 视频最大字节数，不超过 2147483648；后端合并前后均核对实际大小 |
| `MINIO_DIRECT_UPLOAD_PART_SIZE_MB` | 分片大小，默认 16，允许 5–64 MiB |

后端现有的 `MINIO_ENDPOINT`、`MINIO_PORT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET` 保持原值。后端可继续连接 `host.docker.internal:9016`；这个地址不能放进浏览器直传地址。MinIO 自定义区域沿用 `MINIO_REGION`。

论坛使用 HTTPS 时，MinIO 上传入口也需使用 HTTPS；推荐独立上传域名。签名使用公开入口的主机名和端口，反向代理应保留原始 Host 和查询参数，不能在签名生成后更换地址。暂不支持 `/s3` 一类路径前缀。

变更包含新脚本和编辑器扩展接口，服务器必须加载重新构建的镜像，再重建 NodeBB 容器；只修改旧镜像的环境变量不能启用新功能。

## MinIO 侧配置

MinIO 上传端口必须能从用户电脑访问。MinIO 容器或服务可配置：

```yaml
environment:
  MINIO_API_CORS_ALLOW_ORIGIN: 'http://aixsilicon.developers.hisilicon.com:9203'
  MINIO_API_STALE_UPLOADS_EXPIRY: '24h'
```

这些变量属于 **MinIO 服务**，放在 NodeBB 容器中不会生效。Origin 要与浏览器地址栏的协议、主机、端口一致；如使用 HTTPS 或多个入口，使用实际 Origin，多个用逗号分隔。

如果另有桶级 CORS，需允许论坛 Origin、`PUT` 和必要的请求头，确保浏览器预检成功。后端直接查询 MinIO 的分片清单来合并，不依赖浏览器读取 `ETag` 响应头。CORS 不是公开桶授权，桶仍须保持私有且不添加公开读取策略。

若上传入口经过 Nginx，默认 16 MiB 分片可设置 `client_max_body_size 32m`、`proxy_request_buffering off` 和适合网络情况的读写超时。这个设置放在 **MinIO 上传入口**；NodeBB 入口只接收小型 JSON 请求，不承载 2 GiB 视频。调整分片大小时同步调整 MinIO 入口单请求限制。

参考：[MinIO CORS](https://docs.min.io/aistor/administration/cors-configuration/)、[MinIO 服务变量](https://github.com/minio/minio/blob/master/docs/config/README.md)。

## 权限、任务和校验

- 创建、签名及完成任务检查登录与 `upload:post:file` 权限；所有写请求使用 CSRF 校验。客户端不能指定桶、对象键或他人的上传任务。
- 文件名扩展名继续遵守论坛白名单/黑名单。后端向 MinIO 查询真实分片编号、数量、每片大小和 ETag，合并后再次检查总大小及文件头类型；不信任浏览器上报的 MIME 或完成清单。
- 只有验证成功才登记为原有 `pending` 私有附件；关联帖子后沿用已有主题权限、视频播放和封面流程。上传过程中不存在可读取的论坛附件。
- 为避免先把 2 GiB 文件下载回 NodeBB，直传记录保存 MinIO 对象 ETag，`sha256` 留空；不把 multipart ETag 当成文件 SHA-256。现有普通附件 SHA-256 流程不变。
- 同一用户最多 3 个未完成任务，全站最多 100 个。取消时中止 multipart，后台每 15 分钟清理过期任务，任务有效期为 24 小时，进程重启后仍能清理。
- 已成功登记但未发布的附件沿用现有附件生命周期。过期任务清理不会删除已关联帖子或已经登记的附件。
- 当前与现有附件关联逻辑一致，使用单个 NodeBB 工作进程；多进程/多实例部署前应增加分布式任务锁和配额原子操作。

## 测试

单元与浏览器逻辑测试位于插件 `test/direct-*.test.js`。真实浏览器集成检查：

```powershell
node --env-file=.env scripts/test-direct-upload.js
node --env-file=.env scripts/test-direct-upload.js --size=2147483648
```

本地测试使用 Chrome、真实数据库和 MinIO，启动独立的回环测试服务。默认 48 MiB，第二条为 2 GiB。它会模拟一次分片连接中断，验证 CORS、重试、合并、播放、完整 SHA-256 一致性和取消；结束后删除本次随机对象和记录。结果写入 `backups/direct-upload-test/result.json`。可用 `CHROME_PATH` 指定浏览器路径。

服务器人工测试建议：上传一个小视频、超过普通附件上限的视频、接近 2 GiB 的视频；检查浏览器网络面板，视频 `PUT` 请求应直达 MinIO。上传中短暂断网后恢复、主动取消、超过 2 GiB 拒绝，以及无权限用户读取附件均应验证。
