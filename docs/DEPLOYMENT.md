# 独立部署 / Self-hosting

每位用户使用自己的 Cloudflare 账户、Worker、D1 和邮件凭据。部署前请先用
虚构内容演练。源码用于各自账户中的独立部署。

## 1. 本地准备

安装 Node.js 24 LTS（支持 22.19+），解压源码发布包或克隆公开源码仓库。
以下命令适用于 Windows、macOS、Linux：

```sh
npm ci
npm test
npm run build
```

测试使用内存 SQLite 和虚构数据；构建使用 `wrangler.example.toml` 生成 dry-run 产物。
普通开发使用 Node.js 与 npm；生成好的 PDF 字体已包含在源码中。`build`、`dev`、`deploy`
会先构建浏览器 PDF 资源；部署时使用本次构建生成的静态目录。

## 2. 创建自己的基础资源

```sh
npx wrangler login
npx wrangler d1 create afterme
npm run setup:guided
```

引导会请求 D1 ID、Worker HTTPS 地址、寄信服务和核验路径，创建本地
`wrangler.toml`；已有配置保留原样，套餐由您在服务商管理。默认以 `dry-run` 寄信，并设置
`RELEASE_SUSPENDED=true`。选择服务时可用预计的 workers.dev 地址；首次部署
后须将实际地址写回 BASE_URL 并重新部署。Worker 名称默认 afterme，可改名。

保留示例中的 `compatibility_flags = ["nodejs_compat"]`、`PDF_FONTS`、Worker 优先
资源路由和全部五个原生限流绑定。默认 `PDF_GENERATION_MODE="browser"`，Cron
为 `*/5 * * * *`。公开健康快照在 15 分钟后过期，因此请使用默认五分钟配置。请求需要原生限流绑定；生产配置使用平台提供的限流计数。

schema 24 可选 `BACKGROUND_EXECUTION_MODE="staged"`，启用前须完成
[隔离 CPU 验收](BACKGROUND_EXECUTION.md)。独立调度配置还需
`BACKGROUND_LANE_SCHEDULING="true"`，并将 Cron 配为三条
`["* * * * *", "*/2 * * * *", "1-59/2 * * * *"]`，分别推进收件、控制／维护和普通任务。
确认账户容纳全部三条触发器，并分别调度收件、控制与普通任务。
该模式使用 Gmail 分段上传；将 `PDF_MAX_BYTES` 设为本实例验收通过的容量。
默认值为 8 MiB，资源保护上限为 64 MiB；实际交付容量按完整验收结果配置。

## 3. 管理口令与内容密钥

分别生成两段独立、足够长的随机值，使用安全的密码管理器保管。通过交互提示
设置，避免写入命令历史、TOML、截图或 Git：

```sh
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CONTENT_ENCRYPTION_KEY
```

ADMIN_TOKEN 是管理口令，CONTENT_ENCRYPTION_KEY 加密普通信件和私人 PDF。
丢失内容密钥无法恢复密文。不要对已有数据库随意替换内容密钥；先参照恢复说明。
内容密钥还保护 MFA、私人 PDF 分块和后台密文，轮换需要四个独立 cursor 分页迁移及离线恢复验证。
本地开发仅将独立的测试值放入被忽略的 `.dev.vars`：

```dotenv
ADMIN_TOKEN=replace-with-a-local-test-password
CONTENT_ENCRYPTION_KEY=replace-with-a-different-local-test-key
```

仅在不具备原生绑定的隔离开发环境，可额外设置
`ALLOW_LOCAL_RATE_LIMIT_FALLBACK=true`；部署检查会拒绝该选项，不要带到线上。

## 4. 邮件与核验

| 寄信 | 核验 | 必需配置 |
| --- | --- | --- |
| dry-run | 网页或隔离模拟 | 不发真实邮件；适合开发 |
| Gmail | 专用 Gmail 回复 | FROM_EMAIL、VERIFICATION_EMAIL、Gmail OAuth；启用收信 |
| Gmail | 验证网页 | Gmail OAuth，联系人必须能访问 BASE_URL |
| Resend | 专用 Gmail 回复 | 已验证寄信域名、Resend key、Gmail OAuth 与回复邮箱 |
| Resend | 验证网页 | 已验证寄信域名、Resend key，可达的 BASE_URL |

Gmail：创建自己的 Google Cloud OAuth 客户端，并启用 Gmail API。
`GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN` 均通过
`wrangler secret put` 设置。使用 `npm run gmail:oauth` 在自己电脑授权：
启动前通过本机环境或安全凭据工具提供 client ID/secret，不要公开 OAuth 输出
文件或授权 URL。脚本仅监听本机，输出保存在忽略的 `.gmail-oauth.local.json`。

寄信需要 gmail.send，回复核验需要 gmail.readonly。外部 OAuth 应用处于 Testing
且使用 Gmail scope 时，刷新令牌可能七天过期，须重新授权并更新 Worker secret。
[Google 官方说明](https://developers.google.com/identity/protocols/oauth2)

Resend：自行选择套餐与域名，在服务商验证 FROM_EMAIL 对应域名，设置
`RESEND_API_KEY`。请在服务商管理套餐。INBOUND_PROVIDER 明确选择 gmail
或 web，分别提供邮箱回复或网页核验。每日上限须符合所选服务和部署额度。

如果联系人无法访问 workers.dev，应选择可实际收取回复的 Gmail 核验路径。
请在自己的实例核对网络环境、邮箱送达能力和联系人可达性。

## 5. 迁移与部署

```sh
npm run setup:guided -- --check
npm run d1:migrate:remote
npm run deploy
```

这些命令读取你自己的 `wrangler.toml`，会修改对应的远程资源。引导可逐步执行
同样操作。不要用示例数据库 ID部署。初次部署后，核对实际 BASE_URL。

打开 `/admin`，用自己的口令登录，填写本人姓名、提醒邮箱，并在统一人员目录录入人员和邮件语言。
确认和收信是可由同一人承担的两种用途；请在相应名单分别勾选人员。保存规则后由本人签到采用。核对 `/health/operational`
及首个自然 Cron；示例每五分钟推进有限工作。先在维护页绑定自己的验证器并独立保存
恢复码，再逐一检查 Cloudflare、邮箱和代码托管账户各自的 MFA。

## 6. 先演练再启用

```sh
npm run rehearsal:release-flow
```

这是使用内存数据库和模拟邮件提供商的隔离规则演练。真实邮件测试另用自己控制的测试邮箱：
先配置 AFTERME_REHEARSAL_FROM（自己的已授权 Gmail）和
AFTERME_REHEARSAL_EMAIL（自己控制的收件邮箱），再显式执行
`npm run rehearsal:mail`；该命令会发五封带演练标记的真实邮件。
按邮件指令回复后运行 `npm run rehearsal:verify-reply`，用于检查收信结果。线上确认由实际核验流程处理。
不要为演练使用真实联系人名单。

管理页保存文字后会在浏览器后台准备 PDF。重新登录可继续未完成准备；应核对私人信件
和所需语言的公开 PDF 均已就绪，再启用自动交付。旧模式公开 PDF 源数据上限 4 MiB，
单份 PDF 默认上限 8 MiB；分阶段模式分页读源，容量按验收配置。请在自己的隔离实例验证 CPU 与邮件传输容量，并检查实际服务限制、自然
Cron、准备后投递、限流和故障恢复。

核对内容、核验路径、schema 16–24 离线恢复及邮件能力后，自行把 RELEASE_SUSPENDED 改为
false 并部署；数据库内暂停也必须解除。真实邮件需要已启用的正式邮件通道。

维护与升级见 [OPERATIONS](OPERATIONS.md)。部署新代码前下载完整备份并离线校验。
恢复必须使用新的数据库文件；恢复默认暂停释放，旧核验和私人链接作废。
升级应用全部迁移至 `0024` 后再部署匹配代码。上线与公开源码是独立操作；当前验证
范围和剩余步骤见 [OPEN_SOURCE_READINESS](OPEN_SOURCE_READINESS.md)。
