# xiaoliuren-reading

小六壬的公开资料站与受保护版排盘应用发布仓库，由 Cloudflare Pages 发布 `public/`。

本仓库还包含一个 Pages Function，用于在没有填写自己 API Key 时提供受控的免费 AI 额度：

- 代码：`functions/api/deepseek.js`
- 路由：`/api/deepseek`
- 项目方 DeepSeek Key 只保存在服务端，不下发到浏览器。

## 一次性配置（配好后无需日常维护）

1. **建 KV 命名空间**
   Cloudflare Dashboard → Storage & Databases → KV → Create namespace，例如 `xiaoliuren-quota`。

2. **绑定到 Pages 项目**
   Pages 项目 → Settings → Functions → KV namespace bindings → 添加：
   - Variable name：`QUOTA_KV`
   - KV namespace：选择上一步的命名空间

3. **配置 Secret**
   Pages 项目 → Settings → Environment variables → 添加（Production 与 Preview 都加）：
   - `DEEPSEEK_API_KEY`：你的 DeepSeek Key（类型选 Secret / 加密）
   - `IP_SALT`（建议）：任意随机字符串，用于对 IP 做 HMAC 哈希

4. **重新部署**：推送一次（或触发一次部署）让绑定生效。

可选变量：`FREE_USER_LIMIT`(默认 10)、`FREE_IP_LIMIT`(默认 20)、`FREE_GLOBAL_LIMIT`(默认 300)、`ALLOWED_ORIGINS`、`ALLOWED_MODELS`、`DEEPSEEK_BASE_URL`。

## 额度规则

- 每个本机身份：10 次/天
- 每个网络（IPv4 完整地址；IPv6 归并 /64）：20 次/天
- 全站：300 次/天
- 按 UTC+8 自然日重置；计数键带 48h TTL 自动过期，不需要定时任务。

## 维护边界

- `public/` 由主项目 `xiaoliuren-v3/release/` 单向同步得出，不要在这里直接改页面。
- `functions/` 属于本仓库的部署代码，不随 `public/` 同步，也不进入主项目发布包。
- 代理只计数，不记录问念、排盘摘要或模型输出；IP 以 HMAC 哈希后存储。

## 快速自测

```powershell
# 本地（需 wrangler，并在本地创建/模拟 KV 与 DEEPSEEK_API_KEY）
npx wrangler pages dev . --kv QUOTA_KV --binding DEEPSEEK_API_KEY=sk-xxx

# 查询额度
curl -s http://127.0.0.1:8788/api/deepseek -H "X-Client-Id: u_test_local_0001"

# 发起一次（会计数）
curl -s http://127.0.0.1:8788/api/deepseek -H "X-Client-Id: u_test_local_0001" -H "Content-Type: application/json" -d "{\"model\":\"deepseek-chat\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```
