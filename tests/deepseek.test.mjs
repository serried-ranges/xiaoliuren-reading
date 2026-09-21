/**
 * /api/deepseek 代理的本地行为验证（纯 Node，不联网）。
 * 运行：node tests/deepseek.test.mjs
 *
 * 覆盖：额度查询、用户/网络/全局上限、额度回退、来源校验、模型白名单、未配置降级。
 */
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/deepseek.js';

function makeKV() {
  const map = new Map();
  return {
    _map: map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
  };
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

const makeEnv = (kv, extra = {}) => ({ QUOTA_KV: kv, DEEPSEEK_API_KEY: 'sk-test', FREE_QUOTA_ENABLED: 'true', ...extra });
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

// 9) 未绑定 KV 时降级
await ok('未绑定 QUOTA_KV → 查询 available:false / 调用 500', async () => {
  const env = { DEEPSEEK_API_KEY: 'sk-test', FREE_QUOTA_ENABLED: 'true' };
  const q = await get(env, 'u_test_nokv0001');
  assert.equal((await q.json()).available, false);
  const res = await post(env, 'u_test_nokv0001', '198.51.100.70');
  assert.equal(res.status, 500);
});

// 10) 只绑定 KV、未配置项目 Key → 同样必须降级（不能误报可用）
await ok('只绑 KV、无 DEEPSEEK_API_KEY → available:false / 调用 500', async () => {
  const env = { QUOTA_KV: makeKV(), FREE_QUOTA_ENABLED: 'true' };
  const q = await get(env, 'u_test_nokey001');
  assert.equal((await q.json()).available, false);
  const res = await post(env, 'u_test_nokey001', '198.51.100.80');
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'server_not_configured');
});

// 10.1) 默认关闭：不设置 FREE_QUOTA_ENABLED 时一律不启用
await ok('未设置 FREE_QUOTA_ENABLED → 默认关闭', async () => {
  const env = { QUOTA_KV: makeKV(), DEEPSEEK_API_KEY: 'sk-test' };
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
  const kv = makeKV();
  const env = makeEnv(kv);
  const clientId = 'u_test_net00001';
  const ip = '198.51.100.99';
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  const res = await post(env, clientId, ip);
  globalThis.fetch = original;
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_unreachable');
  const after = await (await get(env, clientId, ip)).json();
  assert.equal(after.remaining, 10, '网络异常应回退用户额度');
  const globalSum = [...kv._map.entries()]
    .filter(([key]) => key.startsWith('g:'))
    .reduce((sum, [, value]) => sum + Number(value), 0);
  assert.equal(globalSum, 0, '全局分片应精确回退为 0');
});

console.log(results.join('\n'));
console.log(`\n代理验证通过：${results.length} 项；上游调用 ${upstreamCalls} 次`);
