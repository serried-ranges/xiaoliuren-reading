/**
 * 小六壬 · DeepSeek 受控代理（Cloudflare Pages Function）
 *
 * 路由：/api/deepseek
 *   GET   返回当前身份今日剩余额度（不计数）
 *   POST  转发 Chat Completions，并对免费额度计数（user / ip / global）
 *
 * 设计目标：项目方 Key 只存在于服务端；用户未配置自己的 Key 时走本代理。
 * 额度：user 10/天、ip 10/天、global 300/天；由 Pages Function 直接调用 D1 事务协调。
 *
 * 需要的环境变量 / 绑定：
 *   DEEPSEEK_API_KEY   必需（Secret）
 *   QUOTA_DB           必需（Pages 的 D1 Database binding）
 *   FREE_QUOTA_ENABLED 可选，默认关闭；设为 true/1/on/yes 才启用免费额度
 *   IP_SALT            可选（Secret，用于对 IP 做 HMAC 哈希；不配置则退化为明文前缀）
 *   FREE_USER_LIMIT    可选，默认 10
 *   FREE_IP_LIMIT      可选，默认 10
 *   FREE_GLOBAL_LIMIT  可选，默认 300
 *   ALLOWED_ORIGINS    可选，逗号分隔；默认 https://x6ren.cn,https://www.x6ren.cn
 *   ALLOWED_MODELS     可选，逗号分隔；默认 deepseek-flash,deepseek-v4-pro,deepseek-chat,deepseek-reasoner
 *   DEEPSEEK_BASE_URL  可选，默认 https://api.deepseek.com
 *   TIAN_CHOU_CODE  可选 Secret；配置后启用玑衡添筹令，每次兑换 +5 次
 *   TEST_QUOTA_CODE 旧配置名兼容项；新配置优先
 *
 * 隐私：只计数，不记录问念、排盘摘要或模型输出；IP 以 HMAC 哈希后存储。
 */

const TZ_OFFSET_HOURS = 8;            // UTC+8
const MAX_OUTPUT_TOKENS = 2000;       // 免费额度的输出上限
const MAX_MESSAGES = 12;              // 免费额度的消息条数上限
const TIAN_CHOU_GRANT = 5;
const TIAN_CHOU_FAILURE_LIMIT = 3;
const TIAN_CHOU_DAILY_REDEEM_LIMIT = 3;
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
    ip: num(env.FREE_IP_LIMIT, 10),
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

const COUNTER_INCREMENT_SQL = `
  INSERT INTO quota_counters (day_key, scope, subject_key, used, bonus, base_limit, updated_at)
  VALUES (?, ?, ?, 1, 0, ?, ?)
  ON CONFLICT (day_key, scope, subject_key) DO UPDATE SET
    used = quota_counters.used + 1,
    base_limit = excluded.base_limit,
    updated_at = excluded.updated_at
`;

const COUNTER_BONUS_SQL = `
  INSERT INTO quota_counters (day_key, scope, subject_key, used, bonus, base_limit, updated_at)
  VALUES (?, ?, ?, 0, ?, ?, ?)
  ON CONFLICT (day_key, scope, subject_key) DO UPDATE SET
    bonus = quota_counters.bonus + excluded.bonus,
    base_limit = excluded.base_limit,
    updated_at = excluded.updated_at
`;

const COUNTER_SELECT_SQL = `
  SELECT scope, subject_key, used, bonus
  FROM quota_counters
  WHERE day_key = ? AND (
    (scope = 'user' AND subject_key = ?) OR
    (scope = 'ip' AND subject_key = ?) OR
    (scope = 'global' AND subject_key = 'all') OR
    (scope = 'failed_ip' AND subject_key = ?)
  )
`;

function quotaStateFromRows(env, clientId, ipHash, rows) {
  const base = limits(env);
  const counters = new Map((rows || []).map(row => [`${row.scope}:${row.subject_key}`, row]));
  const user = counters.get(`user:${clientId}`);
  const ip = counters.get(`ip:${ipHash}`);
  const global = counters.get('global:all');
  const userLimit = base.user + (Number(user?.bonus) || 0);
  const ipLimit = base.ip + (Number(ip?.bonus) || 0);
  return {
    userLimit,
    ipLimit,
    remaining: Math.max(0, Math.min(
      userLimit - (Number(user?.used) || 0),
      ipLimit - (Number(ip?.used) || 0),
      base.global - (Number(global?.used) || 0),
    )),
  };
}

let lastCleanupDay = '';
let cleanupTask = null;

function database(env) {
  if (!env.QUOTA_DB) throw new Error('quota_database_unavailable');
  return env.QUOTA_DB;
}

function counterIncrement(db, day, scope, subject, limit) {
  return db.prepare(COUNTER_INCREMENT_SQL).bind(day, scope, subject, limit, Date.now());
}

function counterBonus(db, day, scope, subject, bonus, limit) {
  return db.prepare(COUNTER_BONUS_SQL).bind(day, scope, subject, bonus, limit, Date.now());
}

function dayBefore(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - days)).toISOString().slice(0, 10);
}

async function cleanupOldQuotaData(env, day) {
  if (lastCleanupDay === day) return;
  if (cleanupTask) {
    // A failed best-effort cleanup must not turn concurrent quota checks into 500s.
    try { await cleanupTask; } catch (_) { /* Ignore retention cleanup errors. */ }
    if (lastCleanupDay === day) return;
  }
  cleanupTask = (async () => {
    const db = database(env);
    const meta = await db.prepare(
      'SELECT last_cleanup_day FROM quota_maintenance WHERE maintenance_key = ?'
    ).bind('retention').first();
    if (meta?.last_cleanup_day === day) {
      lastCleanupDay = day;
      return;
    }
    const cutoff = dayBefore(day, 45);
    await db.batch([
      db.prepare('DELETE FROM quota_reservations WHERE day_key < ?').bind(cutoff),
      db.prepare('DELETE FROM quota_counters WHERE day_key < ?').bind(cutoff),
      db.prepare(`
        INSERT INTO quota_maintenance (maintenance_key, last_cleanup_day) VALUES (?, ?)
        ON CONFLICT (maintenance_key) DO UPDATE SET last_cleanup_day = excluded.last_cleanup_day
      `).bind('retention', day),
    ]);
    lastCleanupDay = day;
  })();
  try {
    await cleanupTask;
  } catch (_) {
    // Retention cleanup is best-effort and must not take quota checks offline.
  } finally {
    cleanupTask = null;
  }
}

async function matchesSecretCode(input, expected) {
  const encoder = new TextEncoder();
  const [inputHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(input)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(inputHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

export async function quotaState(env, clientId, ipHash, day) {
  await cleanupOldQuotaData(env, day);
  const result = await database(env).prepare(COUNTER_SELECT_SQL)
    .bind(day, clientId, ipHash, ipHash).all();
  return quotaStateFromRows(env, clientId, ipHash, result.results);
}

export async function reserveQuota(env, day, { reservationId, clientId, ipHash }) {
  const base = limits(env);
  const db = database(env);
  await cleanupOldQuotaData(env, day);
  try {
    const result = await db.batch([
      counterIncrement(db, day, 'user', clientId, base.user),
      counterIncrement(db, day, 'ip', ipHash, base.ip),
      counterIncrement(db, day, 'global', 'all', base.global),
      db.prepare(`
        INSERT INTO quota_reservations
          (reservation_id, day_key, client_key, ip_key, state, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).bind(reservationId, day, clientId, ipHash, Date.now()),
      db.prepare(COUNTER_SELECT_SQL).bind(day, clientId, ipHash, ipHash),
    ]);
    const state = quotaStateFromRows(env, clientId, ipHash, result[4]?.results);
    return { status: 200, body: { remaining: state.remaining, limit: state.userLimit } };
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('quota_user_limit')) {
      const state = await quotaState(env, clientId, ipHash, day).catch(() => null);
      return { status: 429, body: { error: 'daily_limit', scope: 'user', limit: state?.userLimit ?? base.user } };
    }
    if (message.includes('quota_ip_limit')) {
      const state = await quotaState(env, clientId, ipHash, day).catch(() => null);
      return { status: 429, body: { error: 'daily_limit', scope: 'ip', limit: state?.ipLimit ?? base.ip } };
    }
    if (message.includes('quota_global_limit')) return { status: 503, body: { error: 'service_busy' } };
    throw error;
  }
}

async function incrementSpecialCounter(env, day, scope, subject, limit) {
  const db = database(env);
  await db.batch([counterIncrement(db, day, scope, subject, limit)]);
}

async function redeemJihengTianchou(env, { clientId, ipHash, day, code, legacy = false }) {
  const expected = String(env.TIAN_CHOU_CODE || env.TEST_QUOTA_CODE || '').trim();
  const errors = legacy
    ? { unavailable: 'test_quota_unavailable', invalid: 'invalid_test_quota_code', locked: 'test_code_locked', daily: 'test_quota_daily_limit' }
    : { unavailable: 'jiheng_tianchou_unavailable', invalid: 'invalid_jiheng_tianchou_code', locked: 'jiheng_tianchou_locked', daily: 'jiheng_tianchou_daily_limit' };
  if (!expected) return json({ error: errors.unavailable }, 503);
  const provided = String(code || '').trim();
  const validCode = provided.length >= 8 && provided.length <= 128
    && await matchesSecretCode(provided, expected);
  const base = limits(env);
  const db = database(env);
  let failedRow;
  try {
    failedRow = await db.prepare(`
      SELECT used FROM quota_counters WHERE day_key = ? AND scope = 'failed_ip' AND subject_key = ?
    `).bind(day, ipHash).first();
  } catch (_) {
    return json({ error: 'quota_database_unavailable' }, 503);
  }
  if ((Number(failedRow?.used) || 0) >= TIAN_CHOU_FAILURE_LIMIT) return json({ error: errors.locked }, 429);

  if (!validCode) {
    try {
      await incrementSpecialCounter(env, day, 'failed_ip', ipHash, TIAN_CHOU_FAILURE_LIMIT);
    } catch (error) {
      if (String(error?.message || error).includes('test_code_locked')) {
        return json({ error: errors.locked }, 429);
      }
      return json({ error: 'quota_database_unavailable' }, 503);
    }
    return json({ error: errors.invalid }, 400);
  }

  try {
    const result = await db.batch([
      counterIncrement(db, day, 'redeem_user', clientId, TIAN_CHOU_DAILY_REDEEM_LIMIT),
      counterIncrement(db, day, 'redeem_ip', ipHash, TIAN_CHOU_DAILY_REDEEM_LIMIT),
      counterBonus(db, day, 'user', clientId, TIAN_CHOU_GRANT, base.user),
      counterBonus(db, day, 'ip', ipHash, TIAN_CHOU_GRANT, base.ip),
      db.prepare(COUNTER_SELECT_SQL).bind(day, clientId, ipHash, ipHash),
    ]);
    const state = quotaStateFromRows(env, clientId, ipHash, result[4]?.results);
    return json({
      ok: true,
      granted: TIAN_CHOU_GRANT,
      limit: state.userLimit,
      remaining: state.remaining,
      jihengTianchouEnabled: true,
      // Older published frontends still read this field.
      testQuotaEnabled: true,
    });
  } catch (error) {
    if (String(error?.message || error).includes('test_quota_daily_limit')) {
      return json({ error: errors.daily }, 429);
    }
    return json({ error: 'quota_database_unavailable' }, 503);
  }
}

export async function settleQuota(env, day, reservationId, outcome) {
  const db = database(env);
  const reservation = await db.prepare(`
    SELECT day_key, client_key, ip_key, state
    FROM quota_reservations WHERE reservation_id = ?
  `).bind(reservationId).first();
  if (!reservation) return { settled: false, state: 'missing' };
  if (reservation.state !== 'pending') return { settled: false, state: reservation.state };

  if (outcome === 'commit') {
    await db.prepare(`
      UPDATE quota_reservations SET state = 'committed'
      WHERE reservation_id = ? AND state = 'pending' AND settlement_token IS NULL
    `).bind(reservationId).run();
  } else if (outcome === 'refund') {
    const token = crypto.randomUUID();
    await db.batch([
      db.prepare(`
        UPDATE quota_reservations SET settlement_token = ?
        WHERE reservation_id = ? AND state = 'pending' AND settlement_token IS NULL
      `).bind(token, reservationId),
      db.prepare(`
        UPDATE quota_counters SET used = MAX(0, used - 1), updated_at = ?
        WHERE day_key = ? AND scope = 'user' AND subject_key = ?
          AND EXISTS (SELECT 1 FROM quota_reservations WHERE reservation_id = ? AND state = 'pending' AND settlement_token = ?)
      `).bind(Date.now(), reservation.day_key, reservation.client_key, reservationId, token),
      db.prepare(`
        UPDATE quota_counters SET used = MAX(0, used - 1), updated_at = ?
        WHERE day_key = ? AND scope = 'ip' AND subject_key = ?
          AND EXISTS (SELECT 1 FROM quota_reservations WHERE reservation_id = ? AND state = 'pending' AND settlement_token = ?)
      `).bind(Date.now(), reservation.day_key, reservation.ip_key, reservationId, token),
      db.prepare(`
        UPDATE quota_counters SET used = MAX(0, used - 1), updated_at = ?
        WHERE day_key = ? AND scope = 'global' AND subject_key = 'all'
          AND EXISTS (SELECT 1 FROM quota_reservations WHERE reservation_id = ? AND state = 'pending' AND settlement_token = ?)
      `).bind(Date.now(), reservation.day_key, reservationId, token),
      db.prepare(`
        UPDATE quota_reservations SET state = 'refunded', settlement_token = NULL
        WHERE reservation_id = ? AND state = 'pending' AND settlement_token = ?
      `).bind(reservationId, token),
    ]);
  } else {
    throw new Error('invalid_quota_outcome');
  }

  const settled = await db.prepare('SELECT state FROM quota_reservations WHERE reservation_id = ?')
    .bind(reservationId).first();
  return {
    settled: settled?.state === (outcome === 'commit' ? 'committed' : 'refunded'),
    state: settled?.state || 'missing',
  };
}

async function refundQuota(env, day, reservationId) {
  try {
    const result = await settleQuota(env, day, reservationId, 'refund');
    return result.state === 'refunded';
  } catch (_) {
    return false;
  }
}

function refundUnconfirmed(error) {
  return json({ error: 'quota_settlement_failed', upstreamError: error, quotaRefunded: false }, 503);
}

async function failedUpstreamResponse(env, day, reservationId, error, status = 502) {
  if (!await refundQuota(env, day, reservationId)) return refundUnconfirmed(error);
  return json({ error, quotaRefunded: true }, status);
}

function safeUpstreamCauseCode(error) {
  const value = String(error?.cause?.code || error?.code || '');
  return /^[A-Z0-9_]{1,48}$/i.test(value) ? value : 'unknown';
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

function hasUsableText(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!Array.isArray(value)) return false;
  return value.some(part => typeof part === 'string'
    ? part.trim().length > 0
    : part && part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0);
}

function hasCompletionText(payload) {
  const choice = payload?.choices?.[0] || {};
  const content = choice?.message?.content
    || choice?.text
    || payload?.data?.content
    || payload?.content
    || (typeof payload === 'string' ? payload : '');
  return hasUsableText(content);
}

function sseLineHasCompletionText(line) {
  const value = String(line || '').trim();
  if (!value.startsWith('data:')) return false;
  const data = value.slice(5).trim();
  if (!data || data === '[DONE]') return false;
  try {
    const payload = JSON.parse(data);
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    if (choices.some(choice => hasUsableText(
      choice?.delta?.content ?? choice?.message?.content ?? choice?.text,
    ))) return true;
    return hasUsableText(payload?.data?.content ?? payload?.content);
  } catch (_) {
    return false;
  }
}

/** 转发 SSE 时观察可见回答；若请求结束/中断前始终无回答，则回退预占额度。 */
function createQuotaAwareStream(body, env, day, reservationId) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pendingLine = '';
  let hasAnswer = false;
  let settled = false;

  const settleOnce = async (outcome) => {
    if (settled) return;
    await settleQuota(env, day, reservationId, outcome);
    settled = true;
  };

  const inspect = async (chunk, stream = true) => {
    pendingLine += decoder.decode(chunk, { stream });
    const lines = pendingLine.split(/\r?\n/);
    pendingLine = lines.pop() || '';
    for (const line of lines) {
      if (!hasAnswer && sseLineHasCompletionText(line)) {
        await settleOnce('commit');
        hasAnswer = true;
      }
    }
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          await inspect();
          if (!hasAnswer && pendingLine && sseLineHasCompletionText(pendingLine)) {
            await settleOnce('commit');
            hasAnswer = true;
          }
          if (!hasAnswer) await settleOnce('refund');
          reader.releaseLock();
          controller.close();
          return;
        }
        await inspect(value);
        controller.enqueue(value);
      } catch (error) {
        if (!hasAnswer) await settleOnce('refund').catch(() => {});
        try { reader.releaseLock(); } catch (_) { /* 读取失败时尽力释放 */ }
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch (_) { /* 忽略上游取消错误 */ }
      if (!hasAnswer) await settleOnce('refund').catch(() => {});
      try { reader.releaseLock(); } catch (_) { /* 忽略释放错误 */ }
    },
  });
}

const missingConfig = (env) => !env.QUOTA_DB || !env.DEEPSEEK_API_KEY;

/** 功能开关：默认关闭；只有显式设为 true/1/on/yes 才启用。 */
function featureEnabled(env) {
  const raw = String(env.FREE_QUOTA_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
}

/** GET：返回当前身份今日剩余额度，不计数 */
export async function onRequestGet({ request, env }) {
  // 免费额度只有在「开关开启 + D1 已绑定 + 项目 Key 已配置」时才可用；
  // 否则必须返回 available:false，避免前端误以为可用。
  if (!featureEnabled(env)) return json({ available: false, error: 'feature_disabled' });
  if (missingConfig(env)) return json({ available: false, error: 'server_not_configured' });
  const clientId = sanitizeClientId(request.headers.get('X-Client-Id'));
  if (!clientId) return json({ error: 'bad_client_id' }, 400);
  const day = dayKey();
  const ip = normalizeIp(request.headers.get('CF-Connecting-IP'));
  const ipHash = await hashIp(ip, env.IP_SALT);
  let quota;
  try {
    quota = await quotaState(env, clientId, ipHash, day);
  } catch (_) {
    return json({ available: false, error: 'quota_database_unavailable' }, 503);
  }
  return json({
    available: true,
    day,
    timezone: 'UTC+8',
    limit: quota.userLimit,
    remaining: quota.remaining,
    jihengTianchouEnabled: Boolean(String(env.TIAN_CHOU_CODE || env.TEST_QUOTA_CODE || '').trim()),
    // Older published frontends still read this field.
    testQuotaEnabled: Boolean(String(env.TIAN_CHOU_CODE || env.TEST_QUOTA_CODE || '').trim()),
  });
}

/** POST：校验 → 计数 → 转发 → 返回流式结果 */
export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ error: 'forbidden' }, 403);
  if (!featureEnabled(env)) return json({ error: 'feature_disabled' }, 503);
  if (missingConfig(env)) return json({ error: 'server_not_configured' }, 500);

  const clientId = sanitizeClientId(request.headers.get('X-Client-Id'));
  if (!clientId) return json({ error: 'bad_client_id' }, 400);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_request' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400);

  const day = dayKey();
  const ip = normalizeIp(request.headers.get('CF-Connecting-IP'));
  const ipHash = await hashIp(ip, env.IP_SALT);
  if (body.action === 'redeem_jiheng_tianchou' || body.action === 'redeem_test_quota') {
    return redeemJihengTianchou(env, {
      clientId,
      ipHash,
      day,
      code: body.code,
      legacy: body.action === 'redeem_test_quota',
    });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return json({ error: 'bad_request' }, 400);
  }
  const model = String(body.model || '');
  if (!allowedModels(env).includes(model)) return json({ error: 'model_not_allowed' }, 400);

  const reservationId = crypto.randomUUID();
  let reservation;
  try {
    reservation = await reserveQuota(env, day, {
      reservationId,
      clientId,
      ipHash,
    });
  } catch (_) {
    return json({ error: 'quota_database_unavailable' }, 503);
  }
  if (reservation.status !== 200) return json({ ...reservation.body, day }, reservation.status);

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
      signal: request.signal,
    });
  } catch (error) {
    const causeCode = safeUpstreamCauseCode(error);
    const requestAborted = request.signal.aborted;
    const timedOut = error?.name === 'AbortError' || /TIMEOUT|TIMED_OUT/i.test(causeCode);
    const code = requestAborted ? 'upstream_aborted' : timedOut ? 'upstream_timeout' : 'upstream_unreachable';
    const status = code === 'upstream_unreachable' ? 502 : 504;
    // 仅记录可诊断元信息；不记录 Key、问念、IP 或模型请求正文。
    console.error('[deepseek proxy] upstream fetch failed', {
      rayId: request.headers.get('cf-ray') || null,
      code,
      errorName: String(error?.name || 'Error').slice(0, 40),
      causeCode,
    });
    return failedUpstreamResponse(env, day, reservationId, code, status);
  }

  // 网络/服务端/上游限流：不扣用户次数
  if (upstream.status === 429 || upstream.status >= 500) {
    if (!await refundQuota(env, day, reservationId)) return refundUnconfirmed('upstream_error');
    const error = upstream.status === 429 ? 'upstream_rate_limited' : 'upstream_http_error';
    console.warn('[deepseek proxy] upstream returned error status', {
      rayId: request.headers.get('cf-ray') || null,
      code: error,
      upstreamStatus: upstream.status,
    });
    return json({ error, upstreamStatus: upstream.status, quotaRefunded: true }, upstream.status);
  }
  // 项目方 Key 失效或余额不足：回退额度，并让前端降级为「填写自己的 Key」
  if (upstream.status === 401 || upstream.status === 402 || upstream.status === 403) {
    if (!await refundQuota(env, day, reservationId)) return refundUnconfirmed('free_unavailable');
    return json({ error: 'free_unavailable', upstreamStatus: upstream.status }, 503);
  }
  if (!upstream.ok) {
    // 任意失败响应均不应消耗用户免费次数；否则参数类 4xx 会产生“失败也扣额”的错觉。
    if (!await refundQuota(env, day, reservationId)) return refundUnconfirmed('upstream_error');
    const text = await upstream.text().catch(() => '');
    return new Response(text || JSON.stringify({ error: 'upstream_error' }), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const contentType = upstream.headers.get('Content-Type') || 'application/json; charset=utf-8';
  const isSse = payload.stream && !contentType.toLowerCase().includes('application/json');
  let responseBody;

  if (isSse) {
    if (!upstream.body) {
      return failedUpstreamResponse(env, day, reservationId, 'empty_upstream_response');
    }
    responseBody = createQuotaAwareStream(upstream.body, env, day, reservationId);
  } else {
    let text;
    try {
      text = await upstream.text();
    } catch (_) {
      return failedUpstreamResponse(env, day, reservationId, 'upstream_read_failed');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return failedUpstreamResponse(env, day, reservationId, 'invalid_upstream_response');
    }
    if (!hasCompletionText(parsed)) {
      return failedUpstreamResponse(env, day, reservationId, 'empty_upstream_response');
    }
    try {
      await settleQuota(env, day, reservationId, 'commit');
    } catch (_) {
      return refundUnconfirmed('quota_commit_failed');
    }
    responseBody = text;
  }

  return new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Quota-Remaining': String(reservation.body.remaining),
      'X-Quota-Limit': String(reservation.body.limit),
    },
  });
}
