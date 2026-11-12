# NodeBB 压力测试

此目录用于项目自己的压测；原有 `test/` 是 NodeBB 上游测试套件，不运行它来压测已有论坛。
使用项目 Node.js 24 和已安装的依赖，无需再安装压测工具。

## 先做只读测试

```powershell
$env:Path = "D:\software\workspace\developTools\node-v24.22.2-win-x64;" + $env:Path
node tests/load.js tests/load.example.json
```

默认 10 个访客，每人顺序请求板块列表和最新主题，持续 30 秒，请求之间间隔 1 秒。
这是虚拟用户数，不是每秒请求数。脚本不跟随重定向，不请求 OAuth，不注册、发帖或删数据。
访客阅读仍可能产生 NodeBB 原生访问统计和访问日志。

复制为 `tests/load.local.json` 调整地址和负载。按 10、25、50、100 逐级运行，
出现大量错误或服务器明显卡顿时停止增加。可以增加以下真实存在的资源：

```json
{ "path": "/api/category/3/blogs", "arrayField": "topics" }
```

主题详情使用 `/api/topic/实际主题ID/实际slug`，`arrayField` 为 `posts`。
脚本先检查接口返回真实论坛数据；重定向、登录页、错误响应不会计作成功。
`load.js` 与混合测试共用已忽略的会话缓存；本机访问使用独立回环源地址，减少重复登录带来的 IP 限流。
50 用户浏览测试可将配置中的 `users` 设为 50、`durationSeconds` 设为 180，
并轮询多篇真实测试文章。请求间隔是在上一次响应完成后计算，实际 RPS 通常略低于用户数。

可在另一个 PowerShell 终端用 `tests/monitor.ps1` 采样论坛进程，传入监听进程 ID、
本轮独有的 StopFile 和 ReportFile 路径；测试结束后创建 StopFile 以停止采样。
CPU 以单核 100% 为口径，内存为每 5 秒采样值，包含准备登录阶段，
不包含数据库和压测进程。报告的最大值为采样峰值，不是瞬时峰值。

## 使用 NodeBB 自带注册功能准备测试账号

项目还提供通过 NodeBB 原生用户创建接口准备账号的脚本：

```powershell
node --env-file=.env tests/create-users.js 10
```

创建 `test1`～`test10` 普通用户，随机密码仅保存到已忽略的 `tests/accounts.json`，
并生成 `tests/load.local.json` 登录压测配置。脚本不授予管理员或版主权限，
不设置邮箱、不伪造同意标记、不修改审核策略。若名称被其他账号占用则停止，
仅复用具有脚本标记且 UID 与本地文件匹配的测试账号，不重置已有密码。
该命令是显式创建测试数据的维护操作，不包含在压测流量中。

未启用企业强制登录策略时，可以在浏览器访问 `/register` 注册独立测试账号。
当前启用 `UNIPORTAL_REQUIRE_LOGIN=true` 后，访客注册页会跳转企业认证，
请使用上面的 `create-users.js` 准备本地测试账号。
先完成必要的注册确认，并确认可在 `/login?local=1` 使用本地密码登录。
不要使用管理员账号或与真实企业账号相同的用户名，不要为测试关闭正式权限或防护。
管理员本地登录和已创建测试账号的本地登录保留；不要为压测放开正式论坛的访客访问。

测试前创建并复用账号，不在压测循环中注册；批量注册还会触发反垃圾和限流。
大量本地登录同样可能触发 IP 限流，脚本遇到登录失败就停止，不绕过限制。

创建 `tests/accounts.json`（已忽略，不提交 Git）：

```json
[
  { "username": "loadtest01", "password": "填写测试密码" },
  { "username": "loadtest02", "password": "填写测试密码" }
]
```

在 `tests/load.local.json` 增加 `"accountsFile": "accounts.json"`，并设置 `users` 不超过账号数量。
每个虚拟用户具有独立 Cookie 会话；脚本提前通过 CSRF + `/login` 登录，再验证数字 UID。
登录准备阶段不计入压测时间。账号文件为本地明文，只放测试密码，测试后自行妥善清理。
不要共享 Cookie、企业 token、数据库密码或真实用户密码。

## 结果与限制

报告存入 `tests/results/`（不提交），包含请求数、失败率、RPS、P50/P95/P99 毫秒及错误分类，
不保存响应正文、密码或 Cookie。耗时包含完整响应正文解析；失败也计入延迟。
超出请求超时的延迟归入最后一个直方图区间；账号登录和接口预检不计入报告。

生产容量测试应在服务器生产模式下进行，同时观察容器 CPU、内存、PostgreSQL 延迟。
本机 `dev` 结果只用于排查。此脚本不模拟浏览器资源加载、WebSocket 或写入负载，
因此报告不能直接等同于完整在线人数上限。

Apifox 也可以测试这些 GET 接口；需关闭自动跟随登录跳转并校验响应中的数组字段。
认证场景应为各虚拟用户管理独立 Cookie，并先通过 `/api/config` 获取 CSRF token；
不要把登录接口返回 HTTP 200 本身视为登录成功，需再次核对 `/api/config` 的 `uid` 和 `loggedIn`。

## 有界混合读写测试

```powershell
node --env-file=.env tests/create-users.js 25
node --env-file=.env tests/prepare-mixed.js
node tests/mixed.js tests/mixed.local.json
```

维护脚本创建私有 `load-test-users` 组和带标记的压测板块，仅测试账号及管理员可读，
排除访客、普通注册用户和 fediverse。只在这个板块关闭发帖审核；正式板块的审核和权限不变。
账号仍为普通用户，遵守原有发帖间隔、声望及点赞规则。

默认 25 用户、75 秒、每人每秒约一次操作，浏览为主，最多 5 个主题、15 条回复、25 次点赞。
主题与回复由不同用户执行，避免默认新用户 120 秒发帖间隔；内容统一带 `[LOADTEST ...]`。
点赞只针对本轮其他测试用户的主题。脚本不会删除数据，报告列出本轮写入的主题和帖子 ID。
重复运行会产生另一批测试数据，且可能受原有发帖限流影响。

本机测试时使用真实回环源地址 `127.0.0.2`～`127.0.0.26` 模拟独立客户端，
不伪造代理请求头，不修改登录限流配置。远程服务器压测不使用这些回环地址。
NodeBB 默认同一 IP 每小时最多 20 次本地登录，包含成功登录；不要反复用一个 IP 登录全部账号。
独立 Cookie 会话缓存到已忽略的 `tests/sessions.local.json`，下次运行先验证并复用。
此文件包含登录凭据性质的 Cookie，不能提交或分享。

结果位于 `tests/results/mixed-*.json`，按操作分别记录成功、进入审核队列、失败与延迟。
累计 10 次网络或服务端错误将提前停止。此脚本通过 HTTP 触发服务端通知逻辑，
但没有模拟 WebSocket 在线订阅者；不能据此推算大量实时连接的容量。

报告完成后，可核对实际落库（仅查询，不删除）：

```powershell
node --env-file=.env tests/verify-mixed.js tests/results/mixed-实际运行时间.json
```

校验主题所属板块、作者、主帖、回复内容测试标记和点赞集合，避免仅按 HTTP 状态判断写入成功。
