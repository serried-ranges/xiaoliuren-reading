# xiaoliuren-reading

小六壬公开资料站与受保护版排盘应用发布仓库，由 Cloudflare Pages 发布 `public/`。

本仓库还包含 `/api/deepseek` Pages Function。免费额度直接通过 Pages D1 binding 保存和协调，不需要单独部署 Worker。项目方 DeepSeek Key 只在 Pages Secret 保存。

## Cloudflare 配置

免费额度涉及用户、IP 与全站三层计数。Workers KV 不适合并发原子计数，因此本项目改用 Cloudflare D1。Pages Function 将多层额度预占写入同一 D1 `batch()` 事务，并由 SQL 触发器守住限额；失败、空回答时通过带幂等 reservation 的事务退款。

1. 在 Cloudflare Dashboard 创建 D1 数据库（建议名称 `xiaoliuren-free-quota`），然后打开该数据库的 SQL Console/Query，把本仓库 `quota/schema.sql` 全文粘贴并执行一次。无需部署 Worker，也无需在本步骤安装 Wrangler。

2. 在 Cloudflare Dashboard 打开 Pages 项目 → Settings → Bindings → Add → D1 database：

   - Variable name：`QUOTA_DB`
   - D1 database：选择 `xiaoliuren-free-quota`

   Production 必须绑定；需要 Preview 时也绑定，然后重新部署 Pages。

3. 在 Pages 项目的 Production 和 Preview 环境分别配置：

   - `DEEPSEEK_API_KEY`：项目方模型 Key，类型选择 Secret。
   - `FREE_QUOTA_ENABLED`：可选，默认关闭；设为 `true` 或 `1` 后启用。
   - `IP_SALT`：建议设置为随机 Secret，用于 HMAC 哈希 IP。
   - `TEST_QUOTA_CODE`：可选 Secret；设置后启用测试兑换码。

   可选限额：`FREE_USER_LIMIT` 默认 10，`FREE_IP_LIMIT` 默认 10，`FREE_GLOBAL_LIMIT` 默认 300。其他配置：`ALLOWED_ORIGINS`、`ALLOWED_MODELS`、`DEEPSEEK_BASE_URL`。

旧的 `QUOTA_KV` 不再用于额度读写；确认 D1 链路工作正常后再移除。D1 不会自动导入旧 KV 当天的计数，因此首次切换当天会在新数据库中重新计数，部署前请把这一点纳入切换安排。

## 额度规则与并发行为

- 每个本机身份每天 10 次；每个网络每天 10 次（IPv4 按完整地址，IPv6 归并 `/64`）；全站每天 300 次。所有限额均可由上述变量覆盖，按 UTC+8 自然日重置。
- 测试码配置后，每个本机身份和 IP 每天最多兑换 20 次，每次增加 10 次；兑换不会调用模型。
- 同一天用户/IP/全站预占进入同一 D1 事务；任一触发器拒绝时整批回滚。reservation ID 保证提交或退款幂等，避免并发超发及重复退款。
- 上游失败、无效 JSON、空回答，或流式结束前没有回答内容时，退回本站免费次数。有可见回答后提交扣额。
- 退回的是本站免费额度。若模型服务商已处理请求，是否收取模型费用仍由服务商计费规则决定。
- 配额及 reservation 数据保留 45 天后由 Pages 请求触发清理；代理不记录问念、排盘摘要或模型输出，IP 以 HMAC 哈希后存储。

## 本地测试

运行纯模拟测试，不会调用真实模型：

```powershell
node tests/deepseek.test.mjs
```

若需运行本地 Pages Functions，先将 `<D1_DATABASE_ID>` 替换为 Cloudflare D1 数据库 ID。Wrangler 默认使用本地模拟数据，不会连接远程 D1：

```powershell
Copy-Item wrangler.local.toml.example wrangler.local.toml
# 编辑 wrangler.local.toml，将占位符替换为 D1 数据库 ID
npx --yes wrangler@latest d1 execute xiaoliuren-free-quota --local --config wrangler.local.toml --file=quota/schema.sql
npx --yes wrangler@latest pages dev --config wrangler.local.toml --binding DEEPSEEK_API_KEY=sk-test --var FREE_QUOTA_ENABLED:true
```

`wrangler.local.toml` 会将 Pages Functions 连接到本机模拟 D1，不会连接生产数据库。`sk-test` 仅为占位值；若要本地调用真实模型，需自行提供隔离的测试 Key，不要写入仓库。

## 维护边界

- `public/` 由主项目 `xiaoliuren-v3/release/` 单向同步得出，不要在这里直接改页面。
- `functions/` 与 `quota/schema.sql` 是资料站独立的 Pages/D1 后端代码，不随 `public/` 同步，也不进入主项目静态发布包。
- Pages+D1 部署步骤、无模型状态检查及验收清单见 [`docs/Cloudflare-Pages免费额度部署与验收.md`](docs/Cloudflare-Pages免费额度部署与验收.md)。
