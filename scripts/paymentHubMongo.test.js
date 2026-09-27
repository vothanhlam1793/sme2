// Run: node --test scripts/paymentHubMongo.test.js
// Disposable Mongo only: never load .env, application index.js or a supplied URI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');
const { Keystone } = require('@keystonejs/keystone');
const { MongooseAdapter } = require('@keystonejs/adapter-mongoose');
const { Text, Relationship, Checkbox } = require('@keystonejs/fields');
const { AccountingMongo, bindContext } = require('../func/accountingMongo');
const createRouter = require('../routes/paymentHub');
const security = require('../routes/paymentHubSecurity');

const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
}).trim();
const secret = 'payment-hub-disposable-fixture-secret';
const adminHeaders = { authorization: 'Bearer fixture-admin-session' };
const signed = raw => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { 'x-mona-timestamp': timestamp, 'x-mona-signature': 'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex') };
};

test('actual PaymentHub HTTP routes -> explicitly bound native Mongo fixture', { timeout: 180000 }, async t => {
  const name = `sme2-payment-hub-test-${process.pid}-${Date.now()}`;
  let keystone, server, timer;
  docker('run', '-d', '--rm', '--name', name, '--tmpfs', '/data/db', '--tmpfs', '/data/configdb',
    'mongo:7.0', '--replSet', 'payment_hub_fixture', '--bind_ip_all');
  try {
    const ip = docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
    let primary = false;
    for (let i = 0; i < 60; i++) {
      try {
        docker('exec', name, 'mongosh', '--quiet', '--eval',
          `try { rs.initiate({_id:'payment_hub_fixture',members:[{_id:0,host:'${ip}:27017'}]}) } catch(e) {} if (!db.hello().isWritablePrimary) quit(2)`);
        primary = true;
        break;
      } catch (_) { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    assert.ok(primary, 'disposable replica set elected primary');
    keystone = new Keystone({ name: 'payment-hub-fixture', cookieSecret: 'fixture-only-cookie-secret',
      adapter: new MongooseAdapter({
        mongoUri: `mongodb://${ip}:27017/accounting_fixture_paymenthub_${process.pid}?replicaSet=payment_hub_fixture`,
        useNewUrlParser: true, useUnifiedTopology: true
      }) });
    for (const key of ['Parent', 'CashTransaction', 'PaymentSettlement', 'Log', 'SystemSetting']) {
      keystone.createList(key, require(`../lists/${key}`));
    }
    keystone.createList('Phone', { fields: { parent: { type: Relationship, ref: 'Parent.phone' } } });
    keystone.createList('Student', { fields: { parent: { type: Relationship, ref: 'Parent.hocsinhs' } } });
    keystone.createList('User', { fields: { name: { type: Text }, isAdmin: { type: Checkbox } } });
    for (const key of ['HoaDon', 'PhieuKetSo']) keystone.createList(key, { fields: { name: { type: Text } } });
    await keystone.connect();
    keystone.createApolloServer({ schemaName: 'public' });
    const repo = await new AccountingMongo(keystone, { isolated: true }).initialize();
    const settings = keystone.lists.SystemSetting.adapter.model.collection;
    await settings.insertOne({ key: 'MONAPAY_CONFIG', isSecret: true, value: JSON.stringify({
      ...security.defaults, monapay_enabled: true, webhook_secret: secret,
      receiving_accounts: ['VA123'], auto_settle: true, auto_sync_enabled: false
    }) });
    const admin = { id: String(new repo.ObjectId()), isAdmin: true };
    const staff = { id: String(new repo.ObjectId()), isAdmin: false };
    await repo.collections.User.insertMany([admin, staff].map(user => ({
      _id: repo.id(user.id), name: 'fixture user', isAdmin: user.isAdmin
    })));
    let contextCount = 0;
    const contextOptions = [];
    // FIXTURE SESSION STUB, NOT REAL LOGIN: only these fixed test credentials
    // simulate identities supplied by Keystone's trusted session middleware.
    // The actual route's User-list and admin authorization gates still execute.
    const fixtureKeystone = { _sessionManager: { getSessionMiddleware: () => (req, res, next) => {
      if (req.headers.authorization === adminHeaders.authorization) {
        req.user = admin; req.authedListKey = 'User';
      } else if (req.headers.authorization === 'Bearer fixture-staff-session') {
        req.user = staff; req.authedListKey = 'User';
      } else if (req.headers.authorization === 'Bearer fixture-other-list-session') {
        req.user = admin; req.authedListKey = 'Parent';
      }
      next();
    } } };
    const app = express();
    const originalInterval = global.setInterval;
    try {
      // Capture and clear only this router's real interval before it can tick.
      global.setInterval = (...args) => { timer = originalInterval(...args); return timer; };
      app.use('/api/payment-hub', createRouter(fixtureKeystone, { contextFactory: options => {
        contextCount++;
        contextOptions.push(options);
        return bindContext(keystone.createContext(options), repo);
      } }));
    } finally {
      global.setInterval = originalInterval;
      clearInterval(timer);
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const request = (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port,
        path: `/api/payment-hub${path}`, method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (error) { reject(error); }
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('Fixture HTTP timeout')));
      req.on('error', reject);
      req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
    let number = 1000;
    const parent = async (debt = 100, balance = 0) => {
      const row = { _id: new repo.ObjectId(), code: `PH${++number}`, debt, balance };
      await repo.collections.Parent.insertOne(row);
      return { id: String(row._id), code: row.code };
    };
    const payload = (p, ref, amount = 60) => ({ amount, description: `${p.code} học phí`,
      transaction_code: ref, account_number: 'VA123', bank_name: 'ACB', type: 'income' });
    const webhook = body => {
      const raw = JSON.stringify(body, null, 2) + '\n';
      return request('/monapay-webhook', raw, signed(raw));
    };
    const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data; };
    await t.test('school fund HTTP vouchers, actor attribution, replay and history snapshot', async () => {
      assert.equal((await request('/school-fund/settings')).status, 401);
      const setup = { startDate: '2026-09-27', openingCash: 250000, note: 'Số đầu dự kiến' };
      const saved = ok(await request('/school-fund/settings', setup, adminHeaders));
      assert.equal(saved.status, 'DRAFT');
      assert.equal(saved.updatedBy, admin.id);
      assert.equal(ok(await request('/school-fund/settings', undefined, adminHeaders)).openingCash, 250000);
      assert.equal((await request('/school-fund/settings', { ...setup, startDate: '2026-02-30' }, adminHeaders)).status, 400);
      assert.equal((await request('/school-fund')).status, 401);
      const before = ok(await request('/school-fund', undefined, adminHeaders));
      const body = { operationId: 'http-fund-deposit', type: 'DEPOSIT', amount: 100,
        reason: 'Nộp bù', counterparty: 'Nhà trường', userId: staff.id };
      const posted = ok(await request('/school-fund/vouchers', body, adminHeaders));
      assert.equal(posted.cash, before.cash + 100);
      assert.deepEqual(ok(await request('/school-fund/vouchers', body, adminHeaders)), posted);
      const state = ok(await request('/school-fund', undefined, adminHeaders));
      assert.equal(state.rows[0].userId, admin.id);
      assert.equal(state.rows[0].after, state.cash);
      const reverse = { operationId: 'http-fund-reverse', voucherId: posted.id, reason: 'Hủy phiếu' };
      assert.equal(ok(await request('/school-fund/reversals', reverse, adminHeaders)).cash, before.cash);
      assert.equal((await request('/school-fund?page=bad', undefined, adminHeaders)).status, 400);
    });
    const snapshot = async () => {
      const collections = [...Object.values(repo.collections), settings, repo.operations, repo.outbox, repo.sequences];
      return Promise.all(collections.map(c => c.find({}).sort({ _id: 1 }).toArray()));
    };
    const ledger = async (p, { debt, balance, receipts, settled }) => {
      const row = await repo.collections.Parent.findOne({ _id: repo.id(p.id) });
      assert.deepEqual([row.debt, row.balance], [debt, balance]);
      const cash = await repo.collections.CashTransaction.find({ parent: row._id }).toArray();
      const settlements = await repo.collections.PaymentSettlement.find({ parent: row._id }).toArray();
      const logs = await repo.collections.Log.find({ idItem: p.id }).toArray();
      const operations = await repo.operations.find({ 'intent.parentId': p.id }).toArray();
      const outbox = await repo.outbox.find({ parentId: p.id }).toArray();
      assert.equal(cash.length, receipts);
      assert.equal(operations.length, receipts);
      assert.equal(outbox.length, receipts);
      assert.equal(settlements.length, receipts);
      assert.equal(logs.length, receipts);
      assert.equal(settlements.reduce((sum, s) => sum + s.amount, 0), settled);
      assert.equal(logs.reduce((sum, l) => sum + Number(l.valueChange), 0), settled);
      for (const tx of cash) {
        assert.equal(tx.accountingVersion, 1);
        assert.equal(tx.accountingCredited, true);
        assert.equal(tx.paymentMethod, 'MONA_PAY');
        assert.equal(tx.receivingAccount, 'VA123');
        assert.equal(tx.providerReference, tx.bankRef);
        assert.equal(tx.status, 'ALLOCATED');
        assert.ok(settlements.some(s => String(s.cashTransaction) === String(tx._id)));
      }
      for (const op of operations) {
        const event = outbox.find(e => e._id === op._id);
        assert.deepEqual(event.response, op.response);
        assert.equal(event.event, 'PAYMENT_RECEIVED');
        assert.equal(event.deliveredAt, null);
      }
      return operations;
    };

    await t.test('three parallel signed webhooks replay one durable native outcome, including late replay', async () => {
      const p = await parent();
      const body = payload(p, 'parallel-three');
      const responses = (await Promise.all(Array.from({ length: 3 }, () => webhook(body)))).map(ok);
      responses.forEach(result => assert.deepEqual(result, responses[0]));
      const operations = await ledger(p, { debt: 40, balance: 0, receipts: 1, settled: 60 });
      assert.deepEqual(responses[0], operations[0].response);
      const before = await snapshot();
      assert.deepEqual(ok(await webhook(body)), responses[0], 'late replay must not return legacy { duplicate, id }');
      assert.deepEqual(await snapshot(), before);
      assert.ok(contextOptions.slice(-4).every(options => options.skipAccessControl === true));
    });

    await t.test('admin manual fallback then same-bank-tx late webhook replays original outcome without another credit', async () => {
      const p = await parent();
      const body = payload(p, 'fallback-late');
      const fallback = { parentId: p.id, isNewTx: true, autoSettle: true,
        cashTxData: { amount: body.amount, paymentMethod: 'MONA_PAY', bankRef: body.transaction_code,
          receivingAccount: body.account_number, bankDescription: body.description } };
      const response = ok(await request('/assign-parent', fallback, adminHeaders));
      assert.deepEqual(contextOptions.at(-1), { authentication: { item: admin, listKey: 'User' } });
      const operations = await ledger(p, { debt: 40, balance: 0, receipts: 1, settled: 60 });
      assert.deepEqual(response, operations[0].response);
      assert.equal(operations[0].intent.paymentMethod, 'MONA_PAY');
      assert.equal(operations[0].intent.settleType, 'MANUAL_ACCOUNTANT');
      const cash = await repo.collections.CashTransaction.findOne({ _id: repo.id(response.cashTransaction.id) });
      assert.equal(String(cash.createdBy), admin.id);
      const before = await snapshot();
      assert.deepEqual(ok(await request('/assign-parent', fallback, adminHeaders)), response);
      // Delivery provenance differs, but the economic identity is identical.
      // Replay must preserve the full original outcome and manual audit records.
      const late = await webhook(body);
      assert.deepEqual(ok(late), response);
      assert.deepEqual(await snapshot(), before);
      await ledger(p, { debt: 40, balance: 0, receipts: 1, settled: 60 });
      const settlement = await repo.collections.PaymentSettlement.findOne({ cashTransaction: cash._id });
      assert.equal(settlement.settleType, 'MANUAL_ACCOUNTANT');
      assert.equal(String(settlement.settledBy), admin.id);
    });

    await t.test('two distinct signed bank transactions concurrently settle one parent without lost updates', async () => {
      const p = await parent(100, 10);
      const responses = (await Promise.all([webhook(payload(p, 'distinct-a')), webhook(payload(p, 'distinct-b', 70))])).map(ok);
      assert.notEqual(responses[0].cashTransaction.id, responses[1].cashTransaction.id);
      const operations = await ledger(p, { debt: 0, balance: 40, receipts: 2, settled: 100 });
      responses.forEach(response => assert.deepEqual(response,
        operations.find(op => op.response.cashTransaction.id === response.cashTransaction.id).response));
    });

    await t.test('changed amount, parent or autoSettle on existing native identity returns sanitized HTTP 409', async () => {
      const p = await parent();
      const other = await parent();
      ok(await webhook(payload(p, 'conflicting-amount')));
      const before = await snapshot();
      for (const response of [await webhook(payload(p, 'conflicting-amount', 61)),
        await webhook(payload(other, 'conflicting-amount')),
        await request('/assign-parent', { parentId: p.id, isNewTx: true, autoSettle: false,
          cashTxData: { amount: 60, paymentMethod: 'MONA_PAY', bankRef: 'conflicting-amount',
            receivingAccount: 'VA123' } }, adminHeaders)]) {
        assert.equal(response.status, 409);
        assert.deepEqual(response.body, { success: false, error: 'Yêu cầu xung đột với dữ liệu kế toán' });
        assert.deepEqual(await snapshot(), before);
      }
    });

    await t.test('unrecognized native error remains sanitized HTTP 500 and rolls back writes', async () => {
      const p = await parent();
      const before = await snapshot();
      repo.afterWrite = async () => {
        const error = new Error('ACCOUNTING_CONFLICT private database details');
        error.code = 'ACCOUNTING_CONFLICT_OTHER';
        throw error;
      };
      try {
        const response = await webhook(payload(p, 'unknown-error'));
        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { success: false, error: 'Không thể hoàn tất thao tác thanh toán' });
        assert.deepEqual(await snapshot(), before);
      } finally { repo.afterWrite = async () => {}; }
    });

    await t.test('unauthorized management and invalid webhook signatures leave real DB documents unchanged', async () => {
      const p = await parent();
      const body = payload(p, 'unauthorized');
      const fallback = { parentId: p.id, isNewTx: true, cashTxData: { amount: 60,
        paymentMethod: 'MONA_PAY', bankRef: body.transaction_code, receivingAccount: 'VA123' } };
      const before = await snapshot();
      const contextsBefore = contextCount;
      for (const [path, data] of [['/config', undefined], ['/config', { monapay_enabled: false }],
        ['/sync', {}], ['/assign-parent', fallback]]) {
        for (const [headers, status] of [[{}, 401], [{ authorization: 'Bearer forged', 'x-role': 'super-admin',
          'x-accounting-native': 'true', 'x-skip-access-control': 'true' }, 401],
        [{ authorization: 'Bearer fixture-staff-session' }, 403],
        [{ authorization: 'Bearer fixture-other-list-session' }, 401]]) {
          assert.equal((await request(path, data, headers)).status, status);
          assert.deepEqual(await snapshot(), before);
        }
      }
      assert.equal(contextCount, contextsBefore, 'management rejects before context creation');
      const raw = JSON.stringify(body);
      for (const headers of [{}, { 'x-mona-signature': 'invalid' }, signed(raw + ' ')]) {
        assert.equal((await request('/monapay-webhook', raw, headers)).status, 401);
        assert.deepEqual(await snapshot(), before);
      }
    });
  } finally {
    clearInterval(timer);
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      if (keystone) await keystone.disconnect();
    } finally { docker('stop', name); }
  }
});
