# AfterMe 运维说明

适用于 schema 24（保留旧执行模式）；升级须先验证对应密钥下的完整备份，再应用全部迁移并部署匹配的
程序。部署见 [DEPLOYMENT](DEPLOYMENT.md)，规则见 [SETTINGS_V18](SETTINGS_V18.md)。

## 保存、正式版本与 PDF 就绪

正文保存是独立的持久化操作。私人信件先加密保存；公开遗言先保存草稿，经版本核对后
才应用到正式版本。保存和应用用于准备内容；公开状态按释放规则推进。跨页面的应用／放弃操作也检查文档修订号，
HTTP 409 时必须读取当前版本后明确处理冲突，不能盲目递增修订号重试。

默认浏览器 PDF 模式下，后台线程生成保存版本的 PDF，按 128 KiB 上传，服务端校验
源版本、布局和摘要后才标记就绪。请分别核对“正文已保存”与“PDF 已就绪”两个状态。关闭页面、断网或
会话过期会中断准备，重新登录管理页可继续；私人信件可使用重试按钮。修改正文、正式
版本、收件资料或 PDF 布局后，应再次确认所需 PDF 已准备好。

旧模式公开正式版本的 PDF 源数据预检上限为 4 MiB，单份准备文件默认上限为 8 MiB。
schema 24 分阶段模式分页读取源数据，`PDF_MAX_BYTES` 应采用隔离验收通过的容量，
并满足邮件 MIME 总大小限制。超限、缺字或上传失败时，已保存正文保留，对应 PDF 等待修复后投递。不要
仅为绕过提示而启用旧服务端渲染路径。最大文件容量须在本实例分别通过 Cloudflare CPU、浏览器内存和邮件服务验收。详见 [PDF 流程](PDF_ATTACHMENTS.md)。

## 释放、定时任务与邮件核对

默认 48／72／120 小时节点、三人确认及 72 小时缓冲；私人／公开独立配置。规则只在
下次实际本人签到时生效，本轮继续读取冻结快照。签到或有效误报取消本轮并撤回网页／
链接；误报保留实际本人签到时间。旅行暂停取消确认与缓冲。

旧模式示例 Cron 每 5 分钟运行一次。分阶段独立调度同时启用
`BACKGROUND_EXECUTION_MODE=staged` 和 `BACKGROUND_LANE_SCHEDULING=true`，设置
`["* * * * *", "*/2 * * * *", "1-59/2 * * * *"]` 三条 Cron：收件每分钟推进一步，
控制与维护在偶数分钟交替，普通任务在奇数分钟轮转，各自领取租约。新模式每次只推进一个阶段，完整健康的本轮
收件箱水位不超过 5 分钟才能最终释放。详见 [后台任务](BACKGROUND_EXECUTION.md)。
每次 invocation 限制 D1 调用、SQL 语句和外部请求，
只推进有限收信、提醒与投递；后续 Cron 继续。预算耗尽的任务保留进度并延期；实际提交结果不明的邮件进入人工核对。
实际推进时间取决于积压、每日额度、提供商响应及自然调度。
配置与数据库暂停都须解除才允许释放；已发送附件无法撤回。

当前轮次的未解决收信故障和积压阻止释放。历史故障保留为诊断记录，新轮次按本轮状态推进。维护操作应记录核对原因；不要把仍未处理的当前确认标记为已解决来强行释放。
确定在提交前取消的发送可重试，超时／结果不明必须先查看提供商发件记录，再选择已
送达或允许重试。请分别核对提供商接收、邮件入箱、阅读与回复身份。

信件去重包含内容版本及收件邮箱；相同内容的布局重建沿用原投递回执。口令信件仍需
人工安排交付。某份 PDF 失败时延期该项，并继续处理其余具备交付条件的事项。

## 健康检查

`/health` 表示程序可达。`/health/operational` 读取一行非私人状态快照，并受阅读
限流保护；快照缺失、来自未来或超过 15 分钟会返回异常。Cron 刷新快照，详细收信、
投递和准备详情在经过认证的维护页查看。

首次部署或恢复后，先等自然 Cron，再检查快照、本人状态、当前规则、PDF 就绪和邮件
记录。独立监控须有与发信邮箱故障相互独立的通知方式。请在实例验收中逐项确认外部监控、账户 MFA 和生产邮件当前有效。

## 完整备份与严格恢复

完整导出采用恢复格式 2／schema 24：规范恢复表保存一份。
完整恢复请使用完整备份；资料导出用于查阅资料。新管理页在浏览器用独立备份口令加密整份文件；API／兼容
页面仍返回原始 JSON，应运行 `backup:encrypt` 后妥善处理原文件。

加密封套 2 使用 1 MiB AES-GCM 分块，认证总长度、块数与顺序；PBKDF2-SHA256 为
600,000 次迭代。支持读取旧封套 1。明文 JSON 上限 256 MiB，分块降低加密临时内存，
但完整 JSON 和结果仍占浏览器／CLI 内存。内容密钥、恢复码和备份口令分别保管。

现有 HTTP 完整导出先按当时的恢复数据大小预检，约 16 MiB 以上返回 413，以避免
Worker 一次读取全部内容或 PDF 分块占满内存。预检与快照分两次读取，数据可能在期间增长；完整 JSON 仍占用内存。不要因超限删除原始内容。

较大实例可由部署者在自己的维护窗口获取完整 D1 SQL 导出，再在本机转换：

```sh
npx wrangler d1 export afterme --remote --output output/private-d1.sql
npm run backup:from-d1 -- output/private-d1.sql NEW-encrypted.json --encrypt
npm run backup:verify -- NEW-encrypted.json
```

第一条会访问你配置的远程数据库。执行前核对目标实例与数据库名，暂停并发编辑，并保护导出文件。不要使用 `--no-schema`、`--no-data` 或仅部分表导出。设置好
`AFTERME_BACKUP_PASSPHRASE` 后，`--encrypt` 可以直接生成加密文件，避免额外的
规范明文副本；原 SQL 仍是敏感文件，需自行保管。

`backup:from-d1` 是离线转换器，`.sql`／`.txt` 支持完整 schema 16–24 的 D1
字面量 INSERT 格式；依据导出声明与可信本地迁移的表／列形状识别版本，若含
`d1_migrations` 则交叉核对迁移记录。不会执行导出中的 SQL、DDL、PRAGMA 或 ATTACH。
仅额外接受 D1 的换行编码 `replace(字符串,字符串,char(10或13))`，首参数可嵌套同一
形式至多四层，全部由 JavaScript 解码；其他表达式、不支持语法、缺表／列、未知列及
混合版本会拒绝，完整字段须由输入文件提供。
也接受 schema 16–24 的 SQLite 文件，以只读方式打开；输出保留输入的 schema 版本。
输出只允许新文件、剔除令牌，规范明文上限 256 MiB；转换后必须继续运行严格校验。

schema 23 及以后备份还必须包含完整的一对一人员映射。原联系人和收件人 ID、语言／启停差异及原核验身份标记都会保留；恢复清除中断编辑的临时标记。旧 schema 16–22 载入后补齐映射，原确认名单保留既有选择。详见 [人员目录](PEOPLE_DIRECTORY.md)。

先从安全保管位置读取环境变量，再离线校验；不要将真实口令写入命令历史：

```powershell
$env:CONTENT_ENCRYPTION_KEY = (Get-Content -Raw -LiteralPath .content-encryption-key.local).Trim()
$env:AFTERME_BACKUP_PASSPHRASE = (Get-Content -Raw -LiteralPath .security-backup-passphrase.local).Trim()
try {
  npm run backup:verify -- '完整备份文件的绝对路径.json'
} finally {
  Remove-Item Env:CONTENT_ENCRYPTION_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:AFTERME_BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
}
```

校验兼容 schema 16–24，要求对应版本的数据表与单例记录，检查设置、冻结规则、引用、
私人密文及新 PDF 分块，并实际调用恢复后的设置、目录与正式版本读取，再检查 SQLite
完整性。数据表、配置、密钥及应用冒烟全部通过后才报告成功。

`backup:verify` 创建临时 SQLite 后清理；保留恢复文件可用：

```sh
node scripts/restore-backup.mjs complete-backup.json NEW-recovery.sqlite
```

只允许新文件。恢复保留实际本人签到时间，建立新轮次、暂停释放、关闭公开状态、使旧
核验／私人链接失效并要求重新登录。schema 19+ 保留已启用 MFA，需要原内容密钥；恢复码
散列还依赖原管理口令。必要时提供原 `LEGACY_CONTENT_ENCRYPTION_KEY`。本地恢复生成新的本机数据库；恢复到 Cloudflare 按独立部署与校验步骤进行。

重要修改后导出并校验，保留独立异地副本。生成导出后，请依次确认下载、异地复制与恢复演练完成。

## 内容密钥轮换

先暂停释放、保存可恢复备份并停止并发编辑，保留旧密钥。将新内容密钥和对应旧密钥
配置好之后，使用已认证管理客户端分页调用 `POST /api/maintenance/content-key-migrate`，
提交 `cursor`、`artifact_cursor`、`job_cursor`、`manifest_cursor` 和页大小；下一页继续
返回的四个 cursor，不能在翻页时重置已推进的 cursor。迁移覆盖普通信件、旧 PDF、
已启用／待绑定 MFA 密钥、私人 PDF 分块、后台任务密文和认证清单，比较原值后才更新。
四类记录共享页大小预算；管理接口默认每页一条，允许至多十条。

只有 `has_more:false` 且没有冲突才能结束；有冲突时核对并重新扫描，不能直接删除旧
密钥。在仅依赖新密钥的隔离恢复中验证 MFA、信件、PDF 及任务／清单，再按维护窗口移除旧密钥。
更改管理口令还影响恢复码散列，应重新绑定并保管新恢复码。不要把密钥轮换与普通代码
升级混为一步，也不要在开源准备中自动修改生产 secret。
