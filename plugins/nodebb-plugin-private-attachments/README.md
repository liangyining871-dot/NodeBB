# 论坛私有附件插件

已接管 `/api/post/upload` 的图片、文件和视频上传，保存 MinIO 对象及 PostgreSQL 元数据，
通过论坛地址统一鉴权读取，支持 HEAD 和视频 Range。已接入帖子发布、编辑、主题缩略图
及永久删除，附件继承当前帖子权限。头像、封面、站点及版块资源、自定义表情也统一存入同一个私有桶。

## 配置

本地沿用项目的 `node --env-file=.env` 启动方式，生产由 Compose 注入环境变量。
插件不读取、保存或打印密钥文件。

| 变量 | 说明 |
| --- | --- |
| `MINIO_ENDPOINT` | 必填，主机名或 IPv4 地址，不带协议、端口和路径 |
| `MINIO_PORT` | API 端口，默认 HTTP 9000、HTTPS 443；不是控制台端口 |
| `MINIO_USE_SSL` | `true` 使用 HTTPS，`false` 使用 HTTP；默认 `false` |
| `MINIO_ACCESS_KEY` | 必填，访问密钥 |
| `MINIO_SECRET_KEY` | 必填，密钥原文不做空格裁剪 |
| `MINIO_BUCKET` | 默认 `nodebb` |
| `MINIO_REGION` | 可选，留空时由 SDK 获取区域 |

首版使用没有桶策略的专用私有桶，通过凭证对应的用户策略授权。
检查需要桶存在检查、读取桶策略权限；桶不存在时还需要创建桶权限。
启动检查不会修改已有桶策略，也不会上传或删除测试对象。
实际上传和下载还需凭证具有对象写入、查询及读取权限。

## 本地安装与检查

在项目根目录使用项目要求的 Node.js 版本执行：

```sh
npm install
node --env-file=.env plugins/nodebb-plugin-private-attachments/check.js
node --env-file=.env ./nodebb activate nodebb-plugin-private-attachments
```

重启论坛后插件会再次检查。检查失败会记录脱敏错误；NodeBB 会继续启动，
插件存储保持不可用，不回退到公开文件访问。

## 镜像

插件已加入 `install/package.json`，Docker 构建安装依赖时会安装本地插件和 MinIO SDK。
无需在生产运行时从 npm 单独下载该插件。数据库中的插件启用状态需单独激活一次。
生产启动不使用 `--env-file=.env`，使用 Compose 的 `environment` 或 `env_file` 注入同名变量。
`.dockerignore` 排除运行期上传目录，避免用户资源进入镜像；内置图片、字体、主题和前端构建文件仍随镜像发布。

## 测试

```sh
node --test plugins/nodebb-plugin-private-attachments/test/*.test.js
```

手动验证真实 PostgreSQL 和 MinIO（只创建并清除本次随机测试附件和未加入论坛列表的测试记录）：

```sh
node --env-file=.env plugins/nodebb-plugin-private-attachments/test/integration.js
```

## 上传与读取

- 核心上传入口新增 `filter:uploadPostFile`，复用原有扩展名检查、上传限额、限流及临时文件清理；
  插件检查登录身份、图片/文件上传权限、实际大小和图片尺寸，MIME 不信任浏览器声明。
- 原件为 `<附件ID>/original.<扩展名>`，按论坛图片缩放设置生成的缩略图放在同一 ID 下。
  图片 EXIF 处理沿用论坛设置；原件始终保留，视频原样存储，不转码或生成封面。
- 返回 `url`、`name`、`attachmentId`、`originalUrl`，有缩略图时另含 `thumbnailUrl`。
  `url` 可直接供原编辑器使用；数据库和正文均不保存 MinIO 签名链接。
- 元数据使用 NodeBB 数据库抽象写入 `privateAttachment:<ID>`，保存上传者、名称、MIME、大小、
  对象路径、SHA-256、创建时间、尺寸、变体和状态；不另建表、不初始化数据库。
- 状态为 `uploading → pending → attached`，写入失败标记 `failed`。未发布附件仅上传者可读。
  不做废弃附件自动清理，部分失败对象保留，后续可通过记录核对。
- 统一地址为 `/attachments/<ID>/<original或thumbnail>/<文件名>`，支持论坛子路径。
  服务端鉴权后代理文件流，普通文件强制下载，安全图片和常用视频可内联，禁止共享缓存。
- GET 支持单段、尾部和开放结尾 Range；越界返回 416，多段或无法解析的 Range 忽略并返回完整文件。
  HEAD 返回完整资源头。所有变体及 Range 都进行同一鉴权，无权访问统一返回 404。

## 帖子关联、图片及删除

- 发布和编辑使用可等待的 `filter:post.create`、`filter:post.edit` 校验并关联附件，
  发帖、回复和编辑权限继续由 NodeBB 原生流程检查。关联后检查帖子与主题的读取权限，
  包含版块禁用、已删除回复、已删除主题及定时发布状态，上传者不获得额外读取权限。
- 帖子字段 `privateAttachmentIds` 保存历史附件 ID；`privateAttachments:post:<pid>` 保存删除索引。
  读取时同时确认附件记录与实际保存的帖子字段，未完成发帖时不会提前开放附件。
- 跨帖子粘贴本论坛附件地址时，先检查源附件权限，再生成新 ID，复制原件及全部变体，
  同步改写正文、源内容或主题缩略图地址。同一帖子重复引用同一附件不会重复复制。
- 缩略图上传也存入 MinIO，按 `topicThumbSize` 生成小图，绑定主帖并继承其权限。
  支持主题缩略图添加和排序，以及按论坛设置从正文图片生成列表缩略图。
- 软删除和恢复不删除对象；读取权限随原生帖子状态变化。移除正文链接或缩略图时，
  本版保留历史关联和对象，继续继承原帖权限，便于帖子历史读取；不做自动清理。
- 永久删除帖子时先将附件标记为 `deleting`，删除其原件、缩略图和元数据。
  删除失败标记为 `delete_failed` 并中止原生永久删除，保留索引且禁止读取；
  修复存储后再次永久删除即可重试。独立复制到其他帖子的附件不受影响。
- 关联、复制及删除在单工作进程中串行处理。iRight 和自定义范围尚未接入，
  后续统一扩展 `canReadPost`，不在对象路径或桶策略中保存论坛业务权限。

## 头像、封面及站点资源

- `filter:files.storage` 接管上传目录中的读写、查询、删除、虚拟目录和头像导出。
  处理中的文件继续使用系统临时目录；不接管程序目录和内置资源。
- 保留稳定的 `/assets/uploads/...` 论坛地址；数据库保存逻辑路径到资源 ID 的映射，
  MinIO 中仍为 `<资源ID>/original.<扩展名>`，不按用户账号或日期建立对象目录。
- 用户头像及个人封面遵循资料页访问权限；群组封面还检查隐藏群组成员、邀请和管理权限；
  版块图片和生成图标检查版块权限及禁用状态。删除账户、群组或版块时清理对应资源，群组改名同步更新归属。
- Logo、默认头像、favicon、Touch Icon、Maskable Icon、截图、分享图及表情可由论坛入口匿名读取，
  保证登录页和站点展示正常；桶始终私有，不下发 MinIO 地址。管理员通用文件默认仅管理员可读。
- 生成资源覆盖邮件 Logo、7 种 Touch Icon、SVG/PNG 版块图标和 ActivityPub 表情缓存。
  SVG 使用统一清洗规则和安全响应头，不能执行脚本。
- 自定义表情由本插件在原表情插件之前接管上传和读取，保持原有管理界面和请求格式，
  无需修改 `node_modules`。表情 CSS、表格等前端构建产物继续保留在原构建流程中。
- 后台上传文件管理支持 MinIO 虚拟目录的浏览、创建、上传及删除；资源读取支持 HEAD 和 Range，
  鉴权失败或资源不存在直接返回 404，不回退到磁盘副本。
- 固定地址替换先写入新对象，再切换数据库映射，最后删除旧对象；上传失败仍保留旧资源。
  删除失败的旧对象保留状态供后续核对，不公开访问。不自动迁移或删除旧磁盘附件。
- 原生安装使用的默认 favicon 会在首次需要时从镜像内置文件写入 MinIO，无须重新初始化论坛。
