/**
 * /api/deepseek 代理的本地行为验证（纯 Node，不联网）。
 * 运行：node tests/deepseek.test.mjs
 *
 * 覆盖：额度查询、用户/网络/全局上限、额度回退、来源校验、模型白名单、未配置降级。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequestGet, onRequestPost, reserveQuota, settleQuota } from '../functions/api/deepseek.js';

// 用真实 SQLite 执行 D1 schema 与触发器，模拟 D1 batch 的事务性和串行写入。
const schema = readFileSync(new URL('../quota/schema.sql', import.meta.url), 'utf8');
const makeKV = () => null;

class MemoryStatement {
  constructor(db, sql, params = []) { Object.assign(this, { db, sql, params }); }
  bind(...params) { return new MemoryStatement(this.db, this.sql, params); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class MemoryD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(schema);
  }
  prepare(sql) { return new MemoryStatement(this.db, sql); }
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const sql = statement.sql.trim();
        if (/^(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
          const rows = this.db.prepare(statement.sql).all(...statement.params);
          return { success: true, results: rows, meta: { changes: rows.length } };
        }
        const result = this.db.prepare(statement.sql).run(...statement.params);
        return { success: true, meta: { changes: Number(result.changes) } };
      });
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

let upstreamStatus = 200;
let upstreamCalls = 0;
globalThis.fetch = async () => {
  upstreamCalls++;
  if (upstreamStatus >= 400) {
    return new Response(JSON.stringify({ error: 'upstream' }), {
      status: upstreamStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

const BODY = { model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] };

function makeRequest({ method = 'POST', clientId, ip = '203.0.113.9', origin = 'https://x6ren.cn', body = BODY } = {}) {
  const headers = new Headers();
  if (clientId) headers.set('X-Client-Id', clientId);
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (origin) headers.set('Origin', origin);
  if (method === 'POST') headers.set('Content-Type', 'application/json');
  return new Request('https://x6ren.cn/api/deepseek', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const makeEnv = (_legacyKV, extra = {}) => ({
  QUOTA_DB: new MemoryD1(),
  DEEPSEEK_API_KEY: 'sk-test',
  FREE_QUOTA_ENABLED: 'true',
  ...extra,
});
const get = (env, clientId, ip) => onRequestGet({ request: makeRequest({ method: 'GET', clientId, ip }), env });
const post = (env, clientId, ip, body) => onRequestPost({ request: makeRequest({ method: 'POST', clientId, ip, body }), env });

const results = [];
const ok = (name, fn) => fn().then(() => results.push('✓ ' + name)).catch((e) => { results.push('✗ ' + name + ' :: ' + e.message); throw e; });

// 1) 缺少身份 → 400
await ok('缺少 X-Client-Id → 400', async () => {
  const res = await get(makeEnv(makeKV()));
  assert.equal(res.status, 400);
});

// 2) 初始额度
await ok('首次查询剩余 10', async () => {
  const res = await get(makeEnv(makeKV()), 'u_test_aaaa1111');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.available, true);
  assert.equal(data.limit, 10);
  assert.equal(data.remaining, 10);
});

// 3) 用户上限 10
await ok('第 11 次 → 429 scope=user', async () => {
  const env = makeEnv(makeKV());
  const ip = '198.51.100.10';
  for (let i = 0; i < 10; i++) {
    const res = await post(env, 'u_test_aaaa1111', ip);
    assert.equal(res.status, 200, `第 ${i + 1} 次应为 200`);
    assert.equal(res.headers.get('X-Quota-Limit'), '10');
    assert.equal(res.headers.get('X-Quota-Remaining'), String(9 - i));
  }
  const blocked = await post(env, 'u_test_aaaa1111', ip);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).scope, 'user');
});

// 4) 网络上限 10
await ok('同 IP 第 11 次 → 429 scope=ip', async () => {
  const env = makeEnv(makeKV());
  const ip = '198.51.100.20';
  for (let i = 0; i < 10; i++) {
    const res = await post(env, `u_test_ip${String(i).padStart(6, '0')}`, ip);
    assert.equal(res.status, 200, `第 ${i + 1} 次应为 200`);
  }
  const blocked = await post(env, 'u_test_fresh0001', ip);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).scope, 'ip');
});

// 5) 全局上限 300（用 2 简化验证）
await ok('全局上限触发 → 503 service_busy', async () => {
  const env = makeEnv(makeKV(), { FREE_GLOBAL_LIMIT: 2, FREE_IP_LIMIT: 100 });
  assert.equal((await post(env, 'u_test_g0000001', '198.51.100.31')).status, 200);
  assert.equal((await post(env, 'u_test_g0000002', '198.51.100.32')).status, 200);
  const blocked = await post(env, 'u_test_g0000003', '198.51.100.33');
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error, 'service_busy');
  const day = (await (await get(env, 'u_test_g0000003', '198.51.100.33')).json()).day;
  const partialUserCounter = await env.QUOTA_DB.prepare(`
    SELECT used FROM quota_counters WHERE day_key = ? AND scope = 'user' AND subject_key = ?
  `).bind(day, 'u_test_g0000003').first();
  assert.equal(partialUserCounter, null, '全站超限时同一 D1 batch 中的用户计数也必须回滚');
});

// 6) 上游 5xx 回退额度
await ok('上游 5xx 不扣次数', async () => {
  const env = makeEnv(makeKV());
  const clientId = 'u_test_refund01';
  const ip = '198.51.100.40';
  upstreamStatus = 500;
  const failed = await post(env, clientId, ip);
  assert.equal(failed.status, 500);
  upstreamStatus = 200;
  const after = await (await get(env, clientId, ip)).json();
  assert.equal(after.remaining, 10, '失败请求应回退额度');
});

// 7) 模型白名单
await ok('非白名单模型 → 400', async () => {
  const res = await post(makeEnv(makeKV()), 'u_test_model001', '198.51.100.50', { ...BODY, model: 'gpt-4' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'model_not_allowed');
});

// 8) 来源校验
await ok('非白名单 Origin → 403', async () => {
  const env = makeEnv(makeKV());
  const res = await onRequestPost({ request: makeRequest({ clientId: 'u_test_origin01', ip: '198.51.100.60', origin: 'https://evil.example' }), env });
  assert.equal(res.status, 403);
});

// 9) 未绑定原子额度协调器时安全降级
await ok('未绑定 QUOTA_DB → 查询 available:false / 调用 500', async () => {
  const env = { DEEPSEEK_API_KEY: 'sk-test', FREE_QUOTA_ENABLED: 'true' };
  const q = await get(env, 'u_test_nokv0001');
  assert.equal((await q.json()).available, false);
  const res = await post(env, 'u_test_nokv0001', '198.51.100.70');
  assert.equal(res.status, 500);
});

// 10) 只绑定 D1、未配置项目 Key → 同样必须降级
await ok('只绑 QUOTA_DB、无 DEEPSEEK_API_KEY → available:false / 调用 500', async () => {
  const env = { QUOTA_DB: new MemoryD1(), FREE_QUOTA_ENABLED: 'true' };
  const q = await get(env, 'u_test_nokey001');
  assert.equal((await q.json()).available, false);
  const res = await post(env, 'u_test_nokey001', '198.51.100.80');
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'server_not_configured');
});

// 10.1) 默认关闭：不设置 FREE_QUOTA_ENABLED 时一律不启用
await ok('未设置 FREE_QUOTA_ENABLED → 默认关闭', async () => {
  const env = { QUOTA_DB: new MemoryD1(), DEEPSEEK_API_KEY: 'sk-test' };
  const qd = await (await get(env, 'u_test_default01')).json();
  assert.equal(qd.available, false);
  assert.equal(qd.error, 'feature_disabled');
  assert.equal((await post(env, 'u_test_default01', '198.51.100.81')).status, 503);
});

// 11) 功能开关：配置齐全但 FREE_QUOTA_ENABLED=false → 关闭免费额度
await ok('FREE_QUOTA_ENABLED=false → 关闭（available:false / 503）', async () => {
  const env = makeEnv(makeKV(), { FREE_QUOTA_ENABLED: 'false' });
  const q = await get(env, 'u_test_switch001');
  const qd = await q.json();
  assert.equal(qd.available, false);
  assert.equal(qd.error, 'feature_disabled');
  const res = await post(env, 'u_test_switch001', '198.51.100.90');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'feature_disabled');
});

// 12) 开关显式开启时正常可用
await ok('FREE_QUOTA_ENABLED=true → 正常可用', async () => {
  const env = makeEnv(makeKV(), { FREE_QUOTA_ENABLED: 'true' });
  const q = await get(env, 'u_test_switch002');
  assert.equal((await q.json()).available, true);
  assert.equal((await post(env, 'u_test_switch002', '198.51.100.91')).status, 200);
});

// 13) 项目方 Key 失效/余额不足 → 回退额度并返回 free_unavailable，让用户走自带 Key
await ok('上游 401/402/403 → 503 free_unavailable 且回退额度', async () => {
  for (const status of [401, 402, 403]) {
    const env = makeEnv(makeKV());
    const clientId = `u_test_auth${status}`;
    const ip = `198.51.100.${status % 100}`;
    upstreamStatus = status;
    const res = await post(env, clientId, ip);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'free_unavailable');
    upstreamStatus = 200;
    const after = await (await get(env, clientId, ip)).json();
    assert.equal(after.remaining, 10, `上游 ${status} 应回退额度`);
  }
});

// 14) 上游网络异常 → 502 upstream_unreachable，并精确回退（含全局分片）
await ok('上游网络异常 → 502 upstream_unreachable 且精确回退', async () => {
  const env = makeEnv(makeKV(), { FREE_GLOBAL_LIMIT: 1 });
  const clientId = 'u_test_net00001';
  const ip = '198.51.100.99';
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  const res = await post(env, clientId, ip);
  globalThis.fetch = original;
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_unreachable');
  const after = await (await get(env, clientId, ip)).json();
  assert.equal(after.remaining, 1, '网络异常应回退额度（受 FREE_GLOBAL_LIMIT=1 限制）');
  assert.equal((await post(env, 'u_test_net00002', '198.51.100.98')).status, 200, '全局额度也必须回退');
});

// 15) 测试码只在服务端配置后开放，兑换额度不触发模型请求
await ok('测试额度兑换开关由 TEST_QUOTA_CODE 服务端 Secret 控制', async () => {
  const env = makeEnv(makeKV());
  const withoutSecret = await (await get(env, 'u_test_code001', '198.51.100.101')).json();
  assert.equal(withoutSecret.testQuotaEnabled, false);
  const unavailable = await post(env, 'u_test_code001', '198.51.100.101', { action: 'redeem_test_quota', code: 'test-code-123' });
  assert.equal(unavailable.status, 503);

  env.TEST_QUOTA_CODE = 'test-code-123456';
  const withSecret = await (await get(env, 'u_test_code001', '198.51.100.101')).json();
  assert.equal(withSecret.testQuotaEnabled, true);
  assert.equal(withSecret.remaining, 10);
});

// 16) 兑换每次 +10，按用户与 IP 同时扩容，仍遵守每日兑换上限
await ok('正确测试码每次兑换增加 10 次且不调用模型', async () => {
  upstreamStatus = 200;
  const env = makeEnv(makeKV(), { TEST_QUOTA_CODE: 'test-code-123456' });
  const clientId = 'u_test_codegrant01';
  const ip = '198.51.100.102';
  const beforeCalls = upstreamCalls;
  const invalid = await post(env, clientId, ip, { action: 'redeem_test_quota', code: 'wrong-code-123' });
  assert.equal(invalid.status, 400);
  assert.equal((await (await get(env, clientId, ip)).json()).remaining, 10, '错误兑换码不得增加额度');

  for (let i = 0; i < 10; i++) assert.equal((await post(env, clientId, ip)).status, 200);
  const redeemed = await post(env, clientId, ip, { action: 'redeem_test_quota', code: 'test-code-123456' });
  assert.equal(redeemed.status, 200);
  const grant = await redeemed.json();
  assert.equal(grant.granted, 10);
  assert.equal(grant.limit, 20);
  assert.equal(grant.remaining, 10);
  assert.equal(upstreamCalls - beforeCalls, 10, '兑换本身不应调用上游模型');
  for (let i = 0; i < 10; i++) assert.equal((await post(env, clientId, ip)).status, 200);
  const exhausted = await post(env, clientId, ip);
  assert.equal(exhausted.status, 429);
  assert.equal((await exhausted.json()).scope, 'user');
  assert.equal((await (await get(env, clientId, ip)).json()).remaining, 0);
});

// 17) 上游任意非 2xx 都回退额度，避免失败响应消耗次数
await ok('上游 4xx 失败请求会回退额度', async () => {
  const env = makeEnv(makeKV());
  const clientId = 'u_test_400refund1';
  const ip = '198.51.100.103';
  upstreamStatus = 400;
  const failed = await post(env, clientId, ip);
  assert.equal(failed.status, 400);
  upstreamStatus = 200;
  const after = await (await get(env, clientId, ip)).json();
  assert.equal(after.remaining, 10);
});

// 18) 上游 HTTP 200 但 JSON 正文无可用回答：回退用户/IP/全站额度
await ok('上游 200 空回答 → 502 empty_upstream_response 且额度全额回退', async () => {
  const env = makeEnv(makeKV(), { FREE_GLOBAL_LIMIT: 1 });
  const clientId = 'u_test_emptyjson01';
  const ip = '198.51.100.104';
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '   ' } }],
    usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const failed = await post(env, clientId, ip, { ...BODY, stream: false });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'empty_upstream_response', quotaRefunded: true });
    assert.equal((await (await get(env, clientId, ip)).json()).remaining, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    assert.equal((await post(env, 'u_test_emptyjson02', '198.51.100.108')).status, 200, '空回答必须归还全站额度');
  } finally {
    globalThis.fetch = original;
  }
});

await ok('上游 200 非 JSON 正文 → invalid_upstream_response 且额度回退', async () => {
  const env = makeEnv(makeKV());
  const clientId = 'u_test_invalidjson1';
  const ip = '198.51.100.105';
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>empty</html>', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const failed = await post(env, clientId, ip, { ...BODY, stream: false });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, 'invalid_upstream_response');
    assert.equal((await (await get(env, clientId, ip)).json()).remaining, 10);
  } finally {
    globalThis.fetch = original;
  }
});

await ok('上游 SSE 无回答 → 流读取结束后回退额度', async () => {
  const env = makeEnv(makeKV(), { FREE_GLOBAL_LIMIT: 1 });
  const clientId = 'u_test_emptysse001';
  const ip = '198.51.100.106';
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: [DONE]\n\n', {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
  try {
    const response = await post(env, clientId, ip, { ...BODY, stream: true });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: [DONE]\n\n');
    assert.equal((await (await get(env, clientId, ip)).json()).remaining, 1);
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    });
    assert.equal((await post(env, 'u_test_emptysse002', '198.51.100.109')).status, 200, '空 SSE 必须归还全站额度');
  } finally {
    globalThis.fetch = original;
  }
});

await ok('上游 SSE 有回答 → 保留扣额并原样转发', async () => {
  const env = makeEnv(makeKV());
  const clientId = 'u_test_valid_sse01';
  const ip = '198.51.100.107';
  const original = globalThis.fetch;
  const body = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => new Response(body, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
  try {
    const response = await post(env, clientId, ip, { ...BODY, stream: true });
    assert.equal(await response.text(), body);
    assert.equal((await (await get(env, clientId, ip)).json()).remaining, 9);
  } finally {
    globalThis.fetch = original;
  }
});

await ok('D1 退款事务故障时不会谎报已退额度', async () => {
  const baseDb = new MemoryD1();
  const failingDb = {
    prepare: sql => baseDb.prepare(sql),
    batch: statements => {
      if (statements.some(statement => statement.sql.includes('SET settlement_token = ?'))) {
        throw new Error('simulated D1 settlement failure');
      }
      return baseDb.batch(statements);
    },
  };
  const env = makeEnv(makeKV(), {
    FREE_GLOBAL_LIMIT: 1,
    QUOTA_DB: failingDb,
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const response = await post(env, 'u_test_refundcoord01', '198.51.100.151', { ...BODY, stream: false });
    const error = await response.json();
    assert.equal(response.status, 503);
    assert.equal(error.error, 'quota_settlement_failed');
    assert.equal(error.quotaRefunded, false);
    assert.equal((await (await get(env, 'u_test_refundcoord01', '198.51.100.151')).json()).remaining, 0);
  } finally {
    globalThis.fetch = original;
  }
});

await ok('SSE 回答已到达但提交扣额失败时会尝试退款', async () => {
  const baseDb = new MemoryD1();
  const failingDb = {
    prepare: sql => baseDb.prepare(sql),
    batch: statements => baseDb.batch(statements),
  };
  const originalRun = baseDb.prepare.bind(baseDb);
  failingDb.prepare = sql => {
    if (sql.includes("SET state = 'committed'")) {
      return { bind: () => ({ run: async () => { throw new Error('simulated D1 commit failure'); } }) };
    }
    return originalRun(sql);
  };
  const env = makeEnv(makeKV(), { QUOTA_DB: failingDb });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
  try {
    const response = await post(env, 'u_test_ssecommit01', '198.51.100.152');
    await assert.rejects(response.text());
    assert.equal((await (await get(env, 'u_test_ssecommit01', '198.51.100.152')).json()).remaining, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await ok('并发同用户请求 → 原子限制不会超发用户额度', async () => {
  const env = makeEnv(makeKV(), { FREE_USER_LIMIT: 3, FREE_IP_LIMIT: 100, FREE_GLOBAL_LIMIT: 100 });
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    post(env, 'u_test_race_user01', `198.51.100.${120 + index}`)));
  assert.equal(responses.filter(response => response.status === 200).length, 3);
  assert.equal(responses.filter(response => response.status === 429).length, 17);
  assert.equal((await (await get(env, 'u_test_race_user01', '198.51.100.120')).json()).remaining, 0);
});

await ok('多用户同 IP 并发 → 原子限制不会超发 IP 额度', async () => {
  const env = makeEnv(makeKV(), { FREE_USER_LIMIT: 100, FREE_IP_LIMIT: 3, FREE_GLOBAL_LIMIT: 100 });
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    post(env, `u_test_race_ip${String(index).padStart(4, '0')}`, '198.51.100.150')));
  assert.equal(responses.filter(response => response.status === 200).length, 3);
  assert.equal(responses.filter(response => response.status === 429).length, 17);
  assert.equal((await (await get(env, 'u_test_race_ip_final', '198.51.100.150')).json()).remaining, 0);
});

await ok('多用户全站并发 → 原子全局上限不会超发', async () => {
  const env = makeEnv(makeKV(), { FREE_USER_LIMIT: 100, FREE_IP_LIMIT: 100, FREE_GLOBAL_LIMIT: 3 });
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    post(env, `u_test_race_g${String(index).padStart(4, '0')}`, `198.51.100.${160 + index}`)));
  assert.equal(responses.filter(response => response.status === 200).length, 3);
  assert.equal(responses.filter(response => response.status === 503).length, 17);
});

await ok('并发重复退款只生效一次（reservation 幂等）', async () => {
  const env = makeEnv(makeKV());
  const day = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const reserved = await reserveQuota(env, day, {
    reservationId: 'idempotent-test-reservation', clientId: 'u_test_idempotent', ipHash: 'ip-idempotent',
  });
  assert.equal(reserved.status, 200);
  const refunds = await Promise.all(Array.from({ length: 10 }, () =>
    settleQuota(env, day, 'idempotent-test-reservation', 'refund')));
  assert.ok(refunds.every(result => result.state === 'refunded'));
  const status = await get(env, 'u_test_idempotent', 'ip-idempotent');
  assert.equal((await status.json()).remaining, 10);
});

console.log(results.join('\n'));
console.log(`\n代理验证通过：${results.length} 项；上游调用 ${upstreamCalls} 次`);
