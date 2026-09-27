# Cloudflare Pages 免费额度部署与验收方案（不部署 Worker）

## 目标与选择

网站、`/api/deepseek` 后端和免费额度代理继续由现有 Cloudflare Pages 项目提供，不另外创建或部署 Worker。Pages Function 通过 D1 binding 直接读写额度。

额度需要支持多用户并发、用户/IP/全站多层上限，并且上游失败或空回答时返还本站额度。Workers KV 的读—改—写不具备这里需要的原子并发语义；本方案改用 D1 的事务批处理。数据库触发器在同一个 D1 batch 内执行额度上限检查，任一层超限即让整批事务回滚，避免只扣到部分计数。D1 `batch()` 会按顺序执行语句，并保证语句作为事务一起提交或回滚。[Pages 可直接绑定 D1](https://developers.cloudflare.com/pages/functions/bindings/)、[D1 batch 事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)

### 组件关系

```text
浏览器
  └─ Cloudflare Pages
       ├─ public/：公开静态页面
       └─ functions/api/deepseek.js：模型代理与额度逻辑
            └─ QUOTA_DB：Cloudflare D1 数据库
                 ├─ quota_counters：每日用户/IP/全站计数与玑衡添筹记录
                 └─ quota_reservations：预占、提交、退款状态
```

无需 `quota/worker.js`、Worker URL、Worker 路由或 Worker Secret。项目方模型 Key 只放在 Pages 的 `DEEPSEEK_API_KEY` Secret。

## 部署涉及的文件

| 文件 | 部署/使用方式 |
|---|---|
| `functions/api/deepseek.js` | 随 Pages 仓库部署，提供 `/api/deepseek` |
| `quota/schema.sql` | 在新 D1 数据库初始化一次；不是网页，也不放进 `public/` |
| `tests/deepseek.test.mjs` | 本地离线测试，不部署 |
| `wrangler.local.toml.example` | 本地 Pages+D1 模拟配置模板；个人副本填入 D1 ID，不部署 |
| `docs/Cloudflare-Pages免费额度部署与验收.md` | 运维文档，仅保存在仓库 `docs/`，不发布到 `public/` |

**不需要手工上传 Worker 文件。**Pages 发布仍沿用现有 Git/Pages 流程；D1 schema 单独执行一次。不要把 `node_modules`、真实 Key、`.env` 或 `.dev.vars` 上传/提交。

## 第一步：创建 D1 数据库

可在 Cloudflare Dashboard 中操作：

1. 打开 **Workers & Pages → D1 SQL Database**（部分界面显示为 **Storage & databases → D1**）。
2. 选择 **Create database**。
3. 数据库名称建议填写 `xiaoliuren-free-quota`，并记录创建结果。

也可用 Wrangler 创建；本项目建议使用 Dashboard 创建，再用下一步的 SQL 文件初始化。

## 第二步：初始化数据库表（推荐用 Dashboard）

进入刚创建的 D1 数据库，打开 **Console / Query**，将资料站仓库 `quota/schema.sql` 的全文粘贴并执行一次。这个最短路径只用 Cloudflare Dashboard，不用额外安装 Wrangler，也不需配置 Worker。

该文件只创建表、索引和限额触发器，不包含 API Key，也不会请求模型。不要重复编辑或手工跳过触发器。

### 初始化成功判据

在 D1 Console 执行：

```sql
SELECT name, type
FROM sqlite_master
WHERE name IN (
  'quota_counters', 'quota_reservations', 'quota_maintenance',
  'quota_user_limit_insert', 'quota_ip_limit_insert', 'quota_global_limit_insert'
)
ORDER BY type, name;
```

至少应看到三张表以及用户/IP/全站限额触发器。完整触发器列表可运行：

```sql
SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;
```

## 第三步：把 D1 绑定到 Pages

Cloudflare Dashboard → **Workers & Pages → Pages → 资料站项目 → Settings → Bindings → Add → D1 database**：

- **Variable name**：`QUOTA_DB`（代码要求这个名字，大小写一致）
- **D1 database**：选择 `xiaoliuren-free-quota`
- **Environment**：至少配置 Production；使用 Pages Preview 时也配置 Preview

保存后需要重新部署 Pages，绑定才会注入新的 Pages Function 版本。Cloudflare Pages 官方流程也是选择 Pages 项目、添加 D1 binding 并重新部署。[Pages D1 binding 步骤](https://developers.cloudflare.com/pages/functions/bindings/)

## 第四步：检查 Pages 变量与 Secret

在 **Settings → Variables and Secrets** 检查 Production（以及使用时的 Preview）：

| 名称 | 类型 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | Secret | 项目方模型 Key；只放在 Pages |
| `FREE_QUOTA_ENABLED` | Text | 填 `true` 或 `1` 才开启免费代理 |
| `IP_SALT` | Secret，推荐 | 稳定随机值，用于哈希 IP；更换会改变 IP 额度标识 |
| `TIAN_CHOU_CODE` | Secret，可选 | 配置后开放玑衡添筹令；每次兑换增加 5 次机会 |
| `TEST_QUOTA_CODE` | Secret，旧配置兼容 | 未设置新配置时读取此旧值；设置 `TIAN_CHOU_CODE` 后以新值为准，可再移除旧项 |
| `FREE_USER_LIMIT` | Text，可选 | 每个浏览器身份每日上限，默认 10 |
| `FREE_IP_LIMIT` | Text，可选 | 每个 IP 每日上限，默认 10 |
| `FREE_GLOBAL_LIMIT` | Text，可选 | 全站每日上限，默认 300 |

`QUOTA_DB` 是 D1 资源绑定，不是普通环境变量。旧 `QUOTA_KV` 可暂时保留，但新代码不再使用它；验证新链路正常后再移除。D1 不会自动导入旧 KV 当天的计数，切换额度存储时当天的剩余次数会重新计数，建议选择低流量时段切换。

玑衡添筹规则：每次兑换增加 5 次；每个浏览器身份与 IP 每天最多兑换 3 次。同一 IP 当天累计 3 次无效兑换后，页面会禁用入口，服务端也会拒绝该网络继续兑换，刷新页面不能绕过；次数按 UTC+8 自然日重置。共用网络的设备共享失败次数。

## 免费计划边界

本方案不额外部署 Worker，但 Pages Function 本身仍按 Cloudflare Workers Free 的请求额度计量，D1 也有独立的每日读写额度；截至 2026-09-28，官方列出的 Free 包含量为 Pages/Workers 100,000 次请求/日、D1 每日 5,000,000 行读取和 100,000 行写入。超出 D1 Free 日额度时查询会失败，而不是无限免费；请在 Cloudflare Dashboard 监控实际用量。应用自设的 300 次/日全站上限与 Cloudflare 平台限额是两套独立限制。[Pages Functions 计量](https://developers.cloudflare.com/pages/functions/pricing/)、[D1 定价与免费额度](https://developers.cloudflare.com/d1/platform/pricing/)

D1 的平台用量与应用自己的额度使用不同的日界线：应用配额按 UTC+8 重置；Cloudflare Workers Free 日用量按其官方规则重置。请勿将两者视为同一计数器。

## 第五步：部署 Pages 代码

确认 Pages 将部署的 Git 分支中包含新的 `functions/api/deepseek.js` 和 `quota/schema.sql`，然后触发 Pages 部署。静态目录仍是原有公开发布内容；本运维文档留在 `docs/`，不要复制到 `public/`。

代码会 fail closed：若没有 `QUOTA_DB` 或 `DEEPSEEK_API_KEY`，免费代理不会悄悄退回到不可靠的 KV 计数。

## 第六步：先做无模型状态验证

状态查询不会调用模型，也不会预占或扣减额度。在 PowerShell 执行：

```powershell
curl.exe -i -H "X-Client-Id: quota-check-0001" https://你的域名/api/deepseek
```

将“你的域名”替换为 Pages 的正式域名。预期 HTTP 200，JSON 类似：

```json
{
  "available": true,
  "day": "2026-09-28",
  "timezone": "UTC+8",
  "limit": 10,
  "remaining": 10,
  "jihengTianchouEnabled": false
}
```

用相同 Client ID 和网络重复查询，`remaining` 应不变。这证明 Pages Function、D1 binding、数据库 schema 和状态读取链路已连通。

### 错误结果速查

| 响应 | 排查方向 |
|---|---|
| `available: true` | D1 与 Pages 状态查询链路正常 |
| `server_not_configured` | `QUOTA_DB` binding 或 `DEEPSEEK_API_KEY` 缺失；确认 Production/Preview 环境后重新部署 Pages |
| `quota_database_unavailable`（HTTP 503） | D1 binding 名字、目标数据库、schema 是否初始化、Pages 部署版本和 Function Logs |
| `feature_disabled` | `FREE_QUOTA_ENABLED` 不是 `true` / `1` |
| D1 报 `no such table` | 尚未执行 `quota/schema.sql`，或 schema 执行到了错误数据库 |
| D1 报 `quota_user_limit` / `quota_ip_limit` / `quota_global_limit` | 对应额度已达到上限；这是数据库触发器阻止并发超发的预期行为 |

## 第七步：功能验收

1. 无模型 `GET` 状态查询通过后，在应用中只发起一次真实解卦。
2. 得到非空回答后再次 `GET`：本站 `remaining` 应减少 1。
3. 空回答、上游失败、读取失败时，Pages Function 应执行退款；再次 `GET` 应看到额度恢复。退款指本站免费额度，不保证模型服务商不计费。
4. 并发限额、重复退款、空 JSON/SSE 等由本地模拟测试覆盖，不用真实模型做压测：

   ```powershell
   cd D:\code\xiaoliuren-reading
   node tests/deepseek.test.mjs
   ```

5. 通过后再查看 Pages **Functions → Logs**，确认没有 `quota_database_unavailable` 或 `server_not_configured`。

并发正确性的关键验收是：多条请求同时竞争同一个 user/IP/global 限额时，成功数不超过上限；任一触发器拒绝预占时，D1 batch 整笔回滚，其他维度不会留下半次计数。重复退款只允许同一个 reservation 从 pending 转成 refunded 一次。[D1 batch 事务行为](https://developers.cloudflare.com/d1/worker-api/d1-database/)

## 本地 Pages+D1 模拟

离线行为测试不需要 Cloudflare 账号或模型 Key：

```powershell
node tests/deepseek.test.mjs
```

如需用浏览器完整调试本地 Pages Function：

```powershell
Copy-Item wrangler.local.toml.example wrangler.local.toml
# 编辑 wrangler.local.toml，将 database_id 占位文本替换为 D1 数据库 ID
npx --yes wrangler@latest d1 execute xiaoliuren-free-quota --local --config wrangler.local.toml --file=quota/schema.sql
npx --yes wrangler@latest pages dev --config wrangler.local.toml --binding DEEPSEEK_API_KEY=sk-test --var FREE_QUOTA_ENABLED:true
```

`wrangler.local.toml` 是本地专用副本，不要提交。`sk-test` 是占位 Key；如需本地真实模型联调，使用隔离的测试 Key，并只通过终端临时变量注入。不要传 `--remote`：本地 Pages+D1 模拟库与线上数据库分离。Pages 的本地 D1 调试需要 Wrangler 配置中的 `preview_database_id`；[D1 本地开发文档](https://developers.cloudflare.com/d1/best-practices/local-development/)与 [Pages D1 binding 文档](https://developers.cloudflare.com/pages/functions/bindings/)说明了此配置和本地存储行为。

## 失败时处理

- D1 schema 初始化或 binding 未通过：不要开启 `FREE_QUOTA_ENABLED`；修正后重新部署 Pages。
- 状态查询正常但真实模型失败：检查 Pages Function Logs、上游 Key/额度和模型返回，不要用多次真实请求做压力测试。
- 要临时关闭免费代理：把 `FREE_QUOTA_ENABLED` 设为 `false` 并重新部署；D1 数据保留。
- 不要删除 D1 数据库来重置每日额度。计数按 UTC+8 日期分区；必要时在确认具体目标和影响后再清理测试数据。

## 执行顺序与完成条件

- [ ] D1 数据库已创建。
- [ ] `quota/schema.sql` 在远程 D1 执行成功，表和触发器存在。
- [ ] Pages Production 已绑定 `QUOTA_DB`；需要时 Preview 也绑定。
- [ ] Pages Secret/Text variables 已配置，保存真实模型 Key 的只有 Pages Secret。
- [ ] 新 Pages Function 版本已部署。
- [ ] `GET /api/deepseek` 返回 `available: true`，重复查询不扣额度。
- [ ] 一次真实调用成功，本站额度按成功/失败语义正确变化。
- [ ] `node tests/deepseek.test.mjs` 全部通过，未使用模型 API 做并发测试。
