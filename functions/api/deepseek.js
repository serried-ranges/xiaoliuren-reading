/**
 * 小六壬 · DeepSeek 受控代理（Cloudflare Pages Function）
 *
 * 路由：/api/deepseek
 *   GET   返回当前身份今日剩余额度（不计数）
 *   POST  转发 Chat Completions，并对免费额度计数（user / ip / global）
 *
 * 设计目标：项目方 Key 只存在于服务端；用户未配置自己的 Key 时走本代理。
 * 额度：user 10/天、ip 20/天、global 300/天，按 UTC+8 自然日重置（日键 + TTL 自动过期，无需定时任务）。
 *
 * 需要的环境变量 / 绑定：
 *   DEEPSEEK_API_KEY   必需（Secret）
 *   QUOTA_KV           必需（KV 命名空间绑定）
 *   IP_SALT            可选（Secret，用于对 IP 做 HMAC 哈希；不配置则退化为明文前缀）
 *   FREE_USER_LIMIT    可选，默认 10
 *   FREE_IP_LIMIT      可选，默认 20
 *   FREE_GLOBAL_LIMIT  可选，默认 300
 *   ALLOWED_ORIGINS    可选，逗号分隔；默认 https://x6ren.cn,https://www.x6ren.cn
 *   ALLOWED_MODELS     可选，逗号分隔；默认 deepseek-flash,deepseek-v4-pro,deepseek-chat,deepseek-reasoner
 *   DEEPSEEK_BASE_URL  可选，默认 https://api.deepseek.com
 *
 * 隐私：只计数，不记录问念、排盘摘要或模型输出；IP 以 HMAC 哈希后存储。
 */

const TZ_OFFSET_HOURS = 8;            // UTC+8
const TTL_SECONDS = 60 * 60 * 48;     // 48 小时覆盖跨天
const GLOBAL_SHARDS = 4;              // 全局计数分片，降低单 key 写频率
const MAX_OUTPUT_TOKENS = 2000;       // 免费额度的输出上限
const MAX_MESSAGES = 12;              // 免费额度的消息条数上限
const DEFAULT_ORIGINS = ['https://x6ren.cn', 'https://www.x6ren.cn'];
const DEFAULT_MODELS = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function limits(env) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    user: num(env.FREE_USER_LIMIT, 10),
    ip: num(env.FREE_IP_LIMIT, 20),
    global: num(env.FREE_GLOBAL_LIMIT, 300),
  };
}

/** UTC+8 自然日，形如 2026-09-21 */
function dayKey() {
  return new Date(Date.now() + TZ_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
}

/** 客户端身份：只保留安全字符，长度不足视为无效 */
function sanitizeClientId(raw) {
  const value = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return value.length >= 8 ? value : '';
}

/** IPv6 归并到 /64；IPv4 原样返回 */
function normalizeIp(raw) {
  const ip = String(raw || '').trim().toLowerCase().split('%')[0];
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail !== undefined ? tail.split(':').filter(Boolean) : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  return full.slice(0, 4).map(group => group.padStart(4, '0')).join(':');
}

async function hashIp(ip, salt) {
  if (!salt) return 'plain_' + ip.replace(/[^a-z0-9:]/g, '').slice(0, 40);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(salt)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readCounter(env, key) {
  return Number(await env.QUOTA_KV.get(key)) || 0;
}

async function increment(env, key, limit) {
  const current = await readCounter(env, key);
  if (current >= limit) return { ok: false, used: current };
  await env.QUOTA_KV.put(key, String(current + 1), { expirationTtl: TTL_SECONDS });
  return { ok: true, used: current + 1 };
}

async function decrement(env, key) {
  try {
    const current = await readCounter(env, key);
    if (current > 0) await env.QUOTA_KV.put(key, String(current - 1), { expirationTtl: TTL_SECONDS });
  } catch (_) { /* 回退失败不影响主流程 */ }
}

/** 全局计数：分片求和后再随机写一个分片，避免单热 key */
async function incrementGlobal(env, day, limit) {
  const keys = Array.from({ length: GLOBAL_SHARDS }, (_, i) => `g:${day}:${i}`);
  const values = await Promise.all(keys.map(key => readCounter(env, key)));
  const total = values.reduce((sum, n) => sum + n, 0);
  if (total >= limit) return { ok: false, total };
  const shard = Math.floor(Math.random() * GLOBAL_SHARDS);
  await increment(env, keys[shard], limit);
  return { ok: true, total: total + 1 };
}

async function refund(env, { userKey, ipKey, day }) {
  await Promise.allSettled([
    decrement(env, userKey),
    decrement(env, ipKey),
    decrement(env, `g:${day}:${Math.floor(Math.random() * GLOBAL_SHARDS)}`),
  ]);
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return true; // 同源/非浏览器请求不拦截
  const allow = String(env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const list = allow.length ? allow : DEFAULT_ORIGINS;
  return list.includes(origin);
}

function allowedModels(env) {
  const list = String(env.ALLOWED_MODELS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

const notConfigured = (env) => !env.QUOTA_KV || !env.DEEPSEEK_API_KEY;

/** GET：返回当前身份今日剩余额度，不计数 */
export async function onRequestGet({ request, env }) {
  if (!env.QUOTA_KV) return json({ available: false, error: 'server_not_configured' });
  const clientId = sanitizeClientId(request.headers.get('X-Client-Id'));
  if (!clientId) return json({ error: 'bad_client_id' }, 400);
  const { user } = limits(env);
  const day = dayKey();
  const used = await readCounter(env, `u:${clientId}:${day}`);
  return json({
    available: true,
    day,
    timezone: 'UTC+8',
    limit: user,
    remaining: Math.max(0, user - used),
  });
}

/** POST：校验 → 计数 → 转发 → 返回流式结果 */
export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ error: 'forbidden' }, 403);
  if (notConfigured(env)) return json({ error: 'server_not_configured' }, 500);

  const clientId = sanitizeClientId(request.headers.get('X-Client-Id'));
  if (!clientId) return json({ error: 'bad_client_id' }, 400);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_request' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400);
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return json({ error: 'bad_request' }, 400);
  }
  const model = String(body.model || '');
  if (!allowedModels(env).includes(model)) return json({ error: 'model_not_allowed' }, 400);

  const limit = limits(env);
  const day = dayKey();
  const ip = normalizeIp(request.headers.get('CF-Connecting-IP'));
  const ipHash = await hashIp(ip, env.IP_SALT);
  const userKey = `u:${clientId}:${day}`;
  const ipKey = `ip:${ipHash}:${day}`;

  const userRes = await increment(env, userKey, limit.user);
  if (!userRes.ok) return json({ error: 'daily_limit', scope: 'user', limit: limit.user, day }, 429);

  const ipRes = await increment(env, ipKey, limit.ip);
  if (!ipRes.ok) {
    await refund(env, { userKey, ipKey, day });
    return json({ error: 'daily_limit', scope: 'ip', limit: limit.ip, day }, 429);
  }

  const globalRes = await incrementGlobal(env, day, limit.global);
  if (!globalRes.ok) {
    await refund(env, { userKey, ipKey, day });
    return json({ error: 'service_busy', day }, 503);
  }

  const payload = {
    model,
    messages: body.messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 1,
    top_p: typeof body.top_p === 'number' ? body.top_p : 1,
    stream: body.stream !== false,
  };
  if (body.thinking && typeof body.thinking === 'object') payload.thinking = body.thinking;
  if (body.reasoning_effort) payload.reasoning_effort = body.reasoning_effort;
  const requestedTokens = Number(body.max_tokens);
  payload.max_tokens = Number.isFinite(requestedTokens) && requestedTokens > 0
    ? Math.min(Math.floor(requestedTokens), MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS;

  const base = String(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  let upstream;
  try {
    upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    await refund(env, { userKey, ipKey, day });
    return json({ error: 'upstream_unreachable' }, 502);
  }

  // 网络/服务端/上游限流：不扣用户次数
  if (upstream.status === 429 || upstream.status >= 500) {
    await refund(env, { userKey, ipKey, day });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return new Response(text || JSON.stringify({ error: 'upstream_error' }), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Quota-Remaining': String(Math.max(0, limit.user - userRes.used)),
      'X-Quota-Limit': String(limit.user),
    },
  });
}
