const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const security = require('../routes/paymentHubSecurity');

// Replace accounting before loading the router: no DB, websocket or provider calls.
const calls = [];
const settlementPath = require.resolve('../func/settlement');
require.cache[settlementPath] = { id: settlementPath, filename: settlementPath, loaded: true, exports: {
  processInflowAndSettle: async (context, params) => { calls.push({ context, params }); return { success: true }; },
  allocateCashTransaction: async (context, params) => { calls.push({ context, params }); return { success: true }; }
} };
const createRouter = require('../routes/paymentHub');
const secret = 'isolated-test-secret-with-32-characters';
const config = { ...security.defaults, monapay_enabled: true, webhook_secret: secret,
  api_token: 'private-token', client_secret: 'private-secret', receiving_accounts: ['VA123'], virtual_account_numbers: ['VA123'] };
const payload = { amount: 50000, description: 'PH000123 học phí', transaction_code: 'FT123',
  account_number: 'VA123', bank_name: 'ACB', type: 'income' };
function signed(raw, timestamp = String(Math.floor(Date.now() / 1000))) {
  return { 'x-mona-timestamp': timestamp, 'x-mona-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex') };
}
async function fixture(run, { graphqlError = false, existingBankRef = false } = {}) {
  let stored = { ...config };
  let queries = 0;
  let cron;
  const originalInterval = global.setInterval;
  global.setInterval = fn => { cron = fn; return { unref() {} }; };
  const keystone = {
    _sessionManager: { getSessionMiddleware: () => [(req, res, next) => {
      // Simulated trusted session adapter, not authorization logic under test.
      if (req.headers.authorization === 'Bearer admin-session') { req.user = { id: 'admin', isAdmin: true }; req.authedListKey = 'User'; }
      if (req.headers.authorization === 'Bearer staff-session') { req.user = { id: 'staff', isAdmin: false }; req.authedListKey = 'User'; }
      next();
    }] },
    createContext: options => ({ ...options, executeGraphQL: async ({ query, variables }) => {
      queries++;
      if (graphqlError) return { errors: [{ message: 'private-secret DB failure' }] };
      const source = query.loc.source.body;
      if (source.includes('updateSystemSetting')) { stored = JSON.parse(variables.value); return { data: { updateSystemSetting: { id: 'config' } } }; }
      if (source.includes('allSystemSettings')) return { data: { allSystemSettings: [{ id: 'config', value: JSON.stringify(stored) }] } };
      if (source.includes('allParents')) return { data: { allParents: [{ id: 'parent' }] } };
      if (source.includes('allCashTransactions')) return { data: { allCashTransactions: existingBankRef ? [{ id: 'existing' }] : [] } };
      throw new Error('Unexpected query');
    } })
  };
  const app = express();
  try { app.use('/api/payment-hub', createRouter(keystone)); } finally { global.setInterval = originalInterval; }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/payment-hub${path}`, method,
      headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  try { await run({ request, stored: () => stored, queries: () => queries, cron }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('management denies anonymous/forged/staff sessions before any DB or accounting access', async () => {
  await fixture(async ({ request, queries }) => {
    calls.length = 0;
    for (const [path, body] of [['/config', undefined], ['/config', {}], ['/sync', {}], ['/assign-parent', { parentId: 'p' }],
      ['/fees', undefined], ['/fees', {}], ['/fees/0123456789abcdef01234567/cancel', { reason: 'test' }],
      ['/fees/0123456789abcdef01234567/attachments', { documentType: 'INVOICE', documentId: 'invoice' }]]) {
      assert.equal((await request(path, body)).status, 401);
      assert.equal((await request(path, body, { authorization: 'Bearer forged', 'x-role': 'super-admin' })).status, 401);
      assert.equal((await request(path, body, { authorization: 'Bearer staff-session' })).status, 403);
    }
    assert.equal(queries(), 0);
    assert.equal(calls.length, 0);
  });
});
test('admin config roundtrip never returns or erases credentials; explicit null clears', async () => {
  await fixture(async ({ request, stored }) => {
    const headers = { authorization: 'Bearer admin-session' };
    const response = await request('/config', undefined, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.data.webhook_secret, '');
    assert.equal(response.body.data.webhook_secret_configured, true);
    assert.ok(!JSON.stringify(response.body).includes(secret));
    assert.ok(!JSON.stringify(response.body).includes('private-token'));
    assert.equal((await request('/config', { ...response.body.data, auto_settle: false }, headers)).status, 200);
    assert.equal(stored().webhook_secret, secret);
    assert.equal(stored().api_token, 'private-token');
    assert.equal(stored().auto_settle, false);
    assert.equal((await request('/config', { api_token: null }, headers)).status, 200);
    assert.equal(stored().api_token, '');
  });
});
test('HTTP webhook accepts exact raw UTF-8 bytes and passes stable reference/account', async () => {
  await fixture(async ({ request }) => {
    calls.length = 0;
    const raw = JSON.stringify(payload, null, 2) + '\n';
    assert.equal((await request('/monapay-webhook', raw, signed(raw))).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.bankRef, 'FT123');
    assert.equal(calls[0].params.providerReference, 'FT123');
    assert.equal(calls[0].params.receivingAccount, 'VA123');
    assert.equal(calls[0].context.skipAccessControl, true);
  });
});
test('missing/malformed/stale/future/raw-only/tampered signatures cannot enter accounting', async () => {
  await fixture(async ({ request }) => {
    calls.length = 0;
    const raw = JSON.stringify(payload);
    for (const headers of [{}, { 'x-mona-signature': 'invalid' },
      signed(raw, String(Math.floor(Date.now() / 1000) - 301)),
      signed(raw, String(Math.floor(Date.now() / 1000) + 302)),
      { ...signed(raw), 'x-mona-timestamp': 'NaN' },
      { ...signed(raw), 'x-mona-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') },
      signed(raw + ' ')]) {
      assert.equal((await request('/monapay-webhook', raw, headers)).status, 401);
    }
    assert.equal(calls.length, 0);
  });
});
test('signed invalid amount/account/direction/reference/test payloads cannot enter accounting', async () => {
  await fixture(async ({ request }) => {
    calls.length = 0;
    for (const change of [{ amount: '50000' }, { amount: '50oops' }, { amount: 0 }, { amount: -1 },
      { amount: 1.5 }, { amount: 2147483648 }, { account_number: 'foreign' }, { account_number: '' },
      { type: 'IN' }, { type: 'expense' }, { type: null }, { transaction_code: '' },
      { is_sandbox: true }, { is_sandbox: 'false' }, { sandbox: true }, { is_test: true },
      { transaction_code: 'TEST_123' }, { transaction_code: 'SANDBOX-123' }, { account_number: 'SBX123' },
      { currency: 'USD' }, { description: {} }, { bank_name: 'OTHER' }]) {
      const raw = JSON.stringify({ ...payload, ...change });
      const res = await request('/monapay-webhook', raw, signed(raw));
      assert.ok([400, 403].includes(res.status), JSON.stringify(change));
    }
    assert.equal(calls.length, 0);
  });
});
test('missing raw bytes or missing/demo secret fail closed', () => {
  const raw = JSON.stringify(payload);
  for (const value of ['', undefined, 'monapay_secret_demo']) assert.throws(() => security.verifyWebhook({ rawBody: Buffer.from(raw), headers: signed(raw) }, value), { status: 503 });
  assert.throws(() => security.verifyWebhook({ headers: signed(raw), body: payload }, secret), { status: 401 });
});
test('existing bankRef keeps legacy duplicate fast-path without another settlement call', async () => {
  await fixture(async ({ request }) => {
    calls.length = 0;
    const raw = JSON.stringify(payload);
    const res = await request('/monapay-webhook', raw, signed(raw));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.duplicate, true);
    assert.equal(calls.length, 0);
  }, { existingBankRef: true });
});
test('GraphQL errors fail closed and never expose database error details', async () => {
  await fixture(async ({ request }) => {
    calls.length = 0;
    const raw = JSON.stringify(payload);
    for (const res of [await request('/monapay-webhook', raw, signed(raw)),
      await request('/config', undefined, { authorization: 'Bearer admin-session' })]) {
      assert.equal(res.status, 500);
      assert.ok(!JSON.stringify(res.body).includes('private-secret'));
    }
    assert.equal(calls.length, 0);
  }, { graphqlError: true });
});
test('manual bank fallback requires and preserves bankRef/account and uses authenticated context', async () => {
  await fixture(async ({ request }) => {
    calls.length = 0;
    const headers = { authorization: 'Bearer admin-session' };
    const body = { parentId: 'parent', isNewTx: true, cashTxData: { amount: 50000, paymentMethod: 'MONA_PAY', bankRef: 'FT123', receivingAccount: 'VA123' } };
    assert.equal((await request('/assign-parent', body, headers)).status, 200);
    assert.equal(calls[0].params.bankRef, 'FT123');
    assert.equal(calls[0].params.receivingAccount, 'VA123');
    assert.equal(calls[0].params.userId, 'admin');
    assert.equal(calls[0].context.authentication.item.id, 'admin');
    assert.equal((await request('/assign-parent', { ...body, cashTxData: { ...body.cashTxData, bankRef: undefined } }, headers)).status, 400);
    assert.equal((await request('/assign-parent', { ...body, cashTxData: { ...body.cashTxData, amount: '50000' } }, headers)).status, 400);
    assert.equal(calls.length, 1);
  });
});
test('OAuth-only sync follows documented pages, filters nonfinal/outbound/sandbox and preserves canonical refs', async () => {
  const cfg = { ...config, api_token: '', client_id: 'client' };
  assert.equal(security.canSync(cfg), true);
  const requests = [];
  const tx = { ...payload, va_nbr: 'VA123', transaction_status: 'SUCCESS', debit_or_credit: 'credit', transaction_content: payload.description };
  const rows = await security.fetchTransactions(cfg, async (path, options) => {
    requests.push({ path, options });
    if (path.includes('/oauth/')) return { access_token: 'oauth-token' };
    assert.equal(options.token, 'oauth-token');
    const page = Number(new URL(path, 'https://example.test').searchParams.get('page'));
    return { current_page: page, has_next: page === 1, data: page === 1 ? [tx,
      { ...tx, transaction_status: 'PENDING' }, { ...tx, debit_or_credit: 'debit' },
      { ...tx, is_sandbox: true }, { ...tx, transaction_code: undefined, id: 'delivery-id' }] : [{ ...tx, transaction_code: 'FT456' }] };
  });
  assert.deepEqual(rows.map(r => r.bankRef), ['FT123', 'FT456']);
  assert.equal(rows[0].receivingAccount, 'VA123');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.form.grant_type, 'client_credentials');
});
test('upstream failures, malformed pagination and OAuth errors propagate, never fall back to old token', async () => {
  await assert.rejects(security.fetchTransactions(config, async () => { throw new Error('upstream failed'); }), /upstream failed/);
  await assert.rejects(security.fetchTransactions(config, async () => ({ items: [] })), /pagination/);
  let count = 0;
  await assert.rejects(security.fetchTransactions({ ...config, client_id: 'client' }, async () => { count++; throw new Error('oauth failed'); }), /oauth failed/);
  assert.equal(count, 1);
});
test('HTTP sync and OAuth cron report failure rather than successful empty scan', async () => {
  const original = security.fetchTransactions;
  let attempts = 0;
  security.fetchTransactions = async () => { attempts++; throw new Error('upstream private-token'); };
  try {
    await fixture(async ({ request, stored, cron }) => {
      calls.length = 0;
      const response = await request('/sync', {}, { authorization: 'Bearer admin-session' });
      assert.equal(response.status, 502);
      assert.equal(response.body.success, false);
      assert.equal(stored().last_sync_result.success, false);
      assert.ok(!JSON.stringify(response.body).includes('private-token'));
      stored().api_token = '';
      stored().client_id = 'client';
      await cron();
      assert.equal(attempts, 2);
      assert.equal(calls.length, 0);
    });
  } finally { security.fetchTransactions = original; }
});
test('provider HTTP adapter uses form OAuth and rejects HTTP/business/JSON/network errors without leaking bodies', async () => {
  for (const response of [{ status: 401, body: '{"success":false,"message":"private-secret"}' },
    { status: 500, body: '{}' }, { status: 200, body: '{"success":false}' },
    { status: 200, body: 'invalid json' }, { network: true }]) {
    const transport = { request(url, options, callback) {
      const req = new EventEmitter();
      req.destroy = error => { req.emit('error', error); req.emit('close'); };
      req.end = body => process.nextTick(() => {
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
        assert.equal(body, 'client_id=id&client_secret=a%26b');
        if (response.network) return req.destroy(new Error('private-secret'));
        const res = new EventEmitter();
        res.statusCode = response.status;
        callback(res);
        res.emit('data', response.body);
        res.emit('end');
        req.emit('close');
      });
      return req;
    } };
    await assert.rejects(security.requestJson('/api/v1/oauth/token', { form: { client_id: 'id', client_secret: 'a&b' } }, transport), error => !error.message.includes('private-secret'));
  }
});
test('provider absolute timeout destroys a hung request and rejects', async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let deadline;
  let destroyed = false;
  let cleared = false;
  global.setTimeout = (fn, delay) => { assert.equal(delay, 15000); deadline = fn; return 'timer'; };
  global.clearTimeout = id => { assert.equal(id, 'timer'); cleared = true; };
  try {
    const pending = security.requestJson('/api/v1/test', {}, { request() {
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = error => { destroyed = true; req.emit('error', error); req.emit('close'); };
      return req;
    } });
    deadline();
    await assert.rejects(pending, /timeout/);
    assert.equal(destroyed, true);
    assert.equal(cleared, true);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

const recoveryConfig = { ...config, virtual_account_numbers: [],
  recovery_callback_url: 'https://school.example/api/payment-hub/monapay-webhook' };
const recoveryLog = { event_type: 'rtxn_callback', endpoint_url: recoveryConfig.recovery_callback_url,
  request_payload: payload, status_code: 500, id: 'delivery-id-not-a-bank-ref' };
test('direct-account recovery requires no VA, uses authenticated actual log pagination and canonical bank refs', async () => {
  const requests = [];
  const first = Array.from({ length: 100 }, () => ({ ...recoveryLog, event_type: 'test' }));
  first[0] = recoveryLog;
  const rows = await security.fetchTransactions(recoveryConfig, async (path, options) => {
    requests.push(path);
    assert.equal(options.token, config.api_token);
    const page = Number(new URL(path, 'https://example.test').searchParams.get('page'));
    return { page, limit: 100, total: 101, items: page === 1 ? first : [{ ...recoveryLog,
      request_payload: JSON.stringify({ ...payload, transaction_code: 'FT456' }) }] };
  });
  assert.deepEqual(requests, ['/api/v1/webhook-logs?page=1&limit=100', '/api/v1/webhook-logs?page=2&limit=100']);
  assert.deepEqual(rows.map(r => r.bankRef), ['FT123', 'FT456']);
  assert.equal(rows[0].receivingAccount, payload.account_number);
});
test('recovery rejects unknown/test events, foreign endpoints, invalid money and sandbox at log/payload level', async () => {
  const logs = [
    ...['webhook', 'test', 'CHECKOUT_PAID', '', undefined].map(event_type => ({ ...recoveryLog, event_type })),
    ...[undefined, 'https://other.example/api/payment-hub/monapay-webhook',
      recoveryConfig.recovery_callback_url + '?school=other', recoveryConfig.recovery_callback_url + '/',
      'https://school.example.evil.test/api/payment-hub/monapay-webhook',
      'https://school.example/api/portal/acb-webhook', 'http://school.example/api/payment-hub/monapay-webhook']
      .map(endpoint_url => ({ ...recoveryLog, endpoint_url })),
    ...[{ is_sandbox: true }, { sandbox: true }, { is_test: true }, { is_sandbox: 'false' }]
      .map(marker => ({ ...recoveryLog, ...marker })),
    ...[{ is_sandbox: true }, { sandbox: true }, { is_test: true }, { flags: ['sandbox'] },
      { flags: 'sandbox' }, { flags: ['unknown'] }, { amount: '50000' }, { amount: 1.5 }, { amount: -1 },
      { type: 'IN' }, { type: 'expense' }, { account_number: 'unknown' }, { account_number: 'SBX123' },
      { transaction_code: undefined, id: 'checkout-id' }, { transaction_code: 'TEST_123' },
      { transaction_code: 'SANDBOX-123' }, { bank_name: 'OTHER' }]
      .map(change => ({ ...recoveryLog, request_payload: { ...payload, ...change } })),
    ...[null, [], 'invalid-json'].map(request_payload => ({ ...recoveryLog, request_payload }))
  ];
  const rows = await security.fetchTransactions(recoveryConfig, async () => ({ page: 1, limit: 100, total: logs.length, items: logs }));
  assert.deepEqual(rows, []);
});
test('recovery fails closed for missing/untrusted callback config and invalid/incomplete/changing pagination', async () => {
  for (const recovery_callback_url of [undefined, '', 'http://school.example/api/payment-hub/monapay-webhook',
    'https://user:pass@school.example/api/payment-hub/monapay-webhook', 'https://school.example/other']) {
    await assert.rejects(security.fetchTransactions({ ...recoveryConfig, recovery_callback_url }, async () => assert.fail('must not call provider')), { status: 503 });
  }
  for (const pageData of [{ items: [] }, { page: 2, limit: 100, total: 0, items: [] },
    { page: 1, limit: 50, total: 0, items: [] }, { page: 1, limit: 100, total: 1, items: [] },
    { page: 1, limit: 100, total: '0', items: [] }]) {
    await assert.rejects(security.fetchTransactions(recoveryConfig, async () => pageData), /pagination|incomplete/);
  }
  let page = 0;
  await assert.rejects(security.fetchTransactions(recoveryConfig, async () => {
    page++;
    return { page, limit: 100, total: page === 1 ? 101 : 102,
      items: page === 1 ? Array(100).fill(recoveryLog) : [recoveryLog, recoveryLog] };
  }), /feed changed/);
});
test('receiving account fallback is explicit env only; an explicit empty allowlist overrides env', async () => {
  const previous = process.env.VIETQR_ACCOUNT_NO;
  try {
    delete process.env.VIETQR_ACCOUNT_NO;
    const cfg = { ...recoveryConfig, receiving_accounts: undefined };
    assert.throws(() => security.inbound(payload, cfg), { status: 503 });
    await assert.rejects(security.fetchTransactions(cfg, async () => assert.fail('must not call provider')), { status: 503 });
    process.env.VIETQR_ACCOUNT_NO = payload.account_number;
    assert.equal(security.inbound(payload, cfg).receivingAccount, payload.account_number);
    assert.throws(() => security.inbound(payload, { ...cfg, receiving_accounts: [] }), { status: 503 });
  } finally {
    if (previous === undefined) delete process.env.VIETQR_ACCOUNT_NO;
    else process.env.VIETQR_ACCOUNT_NO = previous;
  }
});
test('timestamp policy explicitly bounds delayed original-signature retries, future skew and invalid config', () => {
  const now = 1800000000000;
  const raw = JSON.stringify(payload);
  const reqAt = seconds => ({ rawBody: Buffer.from(raw), headers: signed(raw, String(now / 1000 + seconds)) });
  assert.doesNotThrow(() => security.verifyWebhook(reqAt(-300), secret, now));
  assert.throws(() => security.verifyWebhook(reqAt(-301), secret, now), { status: 401 });
  assert.doesNotThrow(() => security.verifyWebhook(reqAt(-3600), secret, now, 3600));
  assert.throws(() => security.verifyWebhook(reqAt(-3601), secret, now, 3600), { status: 401 });
  assert.doesNotThrow(() => security.verifyWebhook(reqAt(-86400), secret, now, 86400));
  assert.throws(() => security.verifyWebhook(reqAt(-86401), secret, now, 86400), { status: 401 });
  assert.doesNotThrow(() => security.verifyWebhook(reqAt(300), secret, now, 86400));
  assert.throws(() => security.verifyWebhook(reqAt(301), secret, now, 86400), { status: 401 });
  for (const age of [0, -1, 299, 86401, Infinity, '3600', null]) {
    assert.throws(() => security.verifyWebhook(reqAt(0), secret, now, age), { status: 503 });
    assert.throws(() => security.mergeConfig(config, { webhook_max_age_seconds: age }), { status: 400 });
  }
});
test('HTTP config wires retry policy and recovery status explicitly reports limited coverage', async () => {
  const original = security.fetchTransactions;
  security.fetchTransactions = async cfg => { assert.deepEqual(cfg.virtual_account_numbers, []); return []; };
  try {
    await fixture(async ({ request, stored }) => {
      const auth = { authorization: 'Bearer admin-session' };
      assert.equal((await request('/config', { virtual_account_numbers: [], recovery_callback_url: recoveryConfig.recovery_callback_url,
        webhook_max_age_seconds: 3600 }, auth)).status, 200);
      const raw = JSON.stringify(payload);
      assert.equal((await request('/monapay-webhook', raw, signed(raw, String(Math.floor(Date.now() / 1000) - 1000)))).status, 200);
      const response = await request('/sync', {}, auth);
      assert.equal(response.status, 200);
      assert.equal(response.body.coverage, 'webhook_log_recovery');
      assert.equal(response.body.fullBankReconciliation, false);
      assert.equal(stored().last_sync_result.coverage, 'webhook_log_recovery');
      const publicResponse = await request('/config', undefined, auth);
      assert.equal(publicResponse.body.data.last_sync_result.fullBankReconciliation, false);
      assert.equal(publicResponse.body.data.last_sync_result.coverage, 'webhook_log_recovery');
    });
  } finally { security.fetchTransactions = original; }
});
