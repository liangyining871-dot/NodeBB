# 企业 Uniportal OAuth2

项目内维护的 NodeBB 4.16.7 插件，不修改核心认证代码。`install/package.json`
包含本地 file 依赖，镜像构建安装依赖时会带入插件。NodeBB 插件启用状态存于数据库，
新部署必须显式启用；不要对已有论坛重新执行 setup。

## 配置和启用

1. 在项目 `.env` 填写 `.env.example` 中的 `UNIPORTAL_*` 参数。
   未确认的端点、客户端 ID、密钥和 scope 保持空白，不复用其他应用的回调地址。
   `AUTH_CLIENT_ID` 留空时使用 `CLIENT_ID`，分别用于授权与 token/userinfo 请求。
2. 确认平台允许 `http://localhost:9203/auth/uniportal/callback`。
   服务器候选地址为 `http://aixsilicon.developers.hisilicon.com:9203/auth/uniportal/callback`，
   正式 HTTPS/代理部署时以浏览器访问地址为准，重新登记回调。
   `url`、浏览器访问地址和回调地址的协议、域名及端口必须统一。
   `localhost` 与 `127.0.0.1` 不共享 Cookie；如果平台登记的是
   `http://127.0.0.1:9203/auth/uniportal/callback`，则 `url` 应设置为
   `http://127.0.0.1:9203`，并从该地址发起登录。插件会在发起认证前先切换到回调域名。
3. 正常安装项目依赖后，运行 `node --env-file=.env ./nodebb activate nodebb-plugin-sso-uniportal`。
   将 `UNIPORTAL_ENABLED=true` 后重启已有论坛。配置不完整时不会展示企业入口。
   本地 Node.js 24 路径和启动方法见根目录部署文档。
4. 登录页增加企业登录按钮。设置 `UNIPORTAL_AUTO_LOGIN=true` 后，未登录访问首页或登录页
   会自动进入企业认证。管理员本地登录入口为 `/login?local=1`，认证失败也回到该入口，
   避免自动认证循环。已登录用户不跳转；其他论坛页面的访客访问权限仍由 NodeBB 控制。
5. 本项目关闭 NodeBB 个人信息同意补充页：数据库配置 `gdpr_enabled=0`。
   企业登录仍正常保存身份、姓名及论坛必要记录，不自动写入 `gdpr_consent=1`。
   邮件摘要保持 `dailyDigestFreq=off`。这两项是论坛数据库配置，并非 `.env` 参数；
   现有数据库部署会保留配置，全新服务器数据库需在管理后台关闭 GDPR 同意提示及邮件摘要。
   更改后重启 NodeBB，让运行进程重新读取配置。若已停留在 `/register/complete`，
   重启后重新访问首页即可继续使用，不必删除账号或重新初始化。

## 行为和恢复

- state 是 256 位随机数，数据库仅存其哈希及浏览器会话 ID 的哈希。
  跳转前先修改并保存 NodeBB 会话，确保 `saveUninitialized:false` 时新浏览器也会收到 Cookie。
  五分钟有效，十分钟物理过期；原子递增确保只能消费一次，包括拒绝授权的回调。
  多个浏览器标签页可分别发起登录。登录失败后重新点击登录，不刷新旧回调。
- token 和 userinfo 均为 POST JSON，不跟随重定向，单次请求超时十秒。
  不保存 token、code、客户端密钥，不把提供方错误或回调参数传给错误日志。
  代理访问日志也应排除回调查询串。
  登录失败页显示对应阶段；服务日志只记录固定阶段标识（如 browser、token、profile、identity），
  不记录企业原始响应、账号、code、state 或 token。`uniportal=failed` 表示登录失败，
  不能据此认定企业登录已经成功。已有本地管理员会话不会被失败的企业认证替换。
- 企业 UID 映射至独立的 NodeBB 数字 UID。用户名使用随机 `up-` 标识，
  用户创建接口负责处理用户名冲突；真实姓名存为 fullname 并在每次登录同步。
  新建企业账号默认展示姓名；插件只为企业账号设置显示名，并遵守隐藏姓名设置。
  不读取邮箱或头像，不按姓名/邮箱关联旧账户，不创建密码或授予管理员权限。
- 使用 NodeBB Passport 回调链完成会话重建、验证钩子、登录跟踪及 WebSocket 通知。
  退出使用 NodeBB 原生退出，只清除论坛会话；企业单点退出尚未对接。
- 按当前单工作进程方案开发。同一身份的并发请求在进程内排队；数据库原子 claim
  防止重复创建。首次创建失败会保留 pending 记录并拒绝后续自动建号。
  这不是完整事务：管理员必须核查 `uniportal:identity:<SHA256(企业UID)>`
  和对应用户的 `uniportalId`。若用户已经创建，人工修复映射；仅在确认没有任何
  对应账户后才可清除该身份的 pending 记录。不可批量清除映射或重初始化论坛。
- 映射指向已删除用户或身份标记不匹配时拒绝登录，不自动重建。禁用用户不能登录。
  无已确认邮箱的用户遵守论坛原有邮件验证及发帖权限策略，不伪造邮件验证。

## 验证

隔离模拟测试（不连接论坛数据库）：

```powershell
node --test plugins/nodebb-plugin-sso-uniportal/test.js
```

测试包含真实本机 HTTP 往返：新会话发出 Cookie、携带 Cookie 的回调成功、
其他浏览器拒绝、重复回调拒绝，以及会话存储失败时禁止发起授权。
测试使用隔离会话存储和模拟认证服务，不修改论坛数据库。

真实联调必须另外验证：首次登录只创建一个普通用户；重复及并发登录复用该用户；
姓名变更同步；原生退出和再次登录；错误/过期/跨浏览器/重复回调拒绝；禁用账户拒绝；
论坛页面和 WebSocket 身份一致；普通用户发帖及管理员入口权限；管理员本地登录仍可用。
企业验证通过后才另行关闭普通用户本地注册和密码登录。模拟测试不替代以上验收。

Docker 离线依赖安装、固定 Node.js 24、精简 compose、前端构建和禁公网验收仍为后续工作。
