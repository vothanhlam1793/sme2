// Run: node --test scripts/feeDomainMongo.test.js
// Disposable Mongo only: never load application env or index.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { Keystone } = require('@keystonejs/keystone');
const { MongooseAdapter } = require('@keystonejs/adapter-mongoose');
const { Text } = require('@keystonejs/fields');
const { FeeDomain } = require('../func/feeDomain');

const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
}).trim();

test('fee domain enforces lifecycle, subjects and active document links', { timeout: 180000 }, async t => {
  const name = `sme2-fee-domain-test-${process.pid}-${Date.now()}`;
  let keystone;
  docker('run', '-d', '--rm', '--name', name, '--tmpfs', '/data/db', '--tmpfs', '/data/configdb',
    'mongo:7.0', '--replSet', 'fee_domain_fixture', '--bind_ip_all');
  try {
    const ip = docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
    let primary = false;
    for (let i = 0; i < 60; i++) {
      try {
        docker('exec', name, 'mongosh', '--quiet', '--eval',
          `try { rs.initiate({_id:'fee_domain_fixture',members:[{_id:0,host:'${ip}:27017'}]}) } catch(e) {} if (!db.hello().isWritablePrimary) quit(2)`);
        primary = true;
        break;
      } catch (_) { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    assert.ok(primary, 'disposable replica set elected primary');
    keystone = new Keystone({ name: 'fee-domain-fixture', cookieSecret: 'fixture-only-cookie-secret',
      adapter: new MongooseAdapter({
        mongoUri: `mongodb://${ip}:27017/fee_domain_fixture_${process.pid}?replicaSet=fee_domain_fixture`,
        useNewUrlParser: true, useUnifiedTopology: true
      }) });
    for (const key of ['Student', 'Parent', 'User']) {
      keystone.createList(key, { fields: { name: { type: Text } } });
    }
    keystone.createList('Fee', require('../lists/Fee'));
    keystone.createList('FeeDocumentLink', require('../lists/FeeDocumentLink'));
    await keystone.connect();

    const objectId = keystone.lists.Fee.adapter.model.db.base.Types.ObjectId;
    const student = new objectId();
    const parent = new objectId();
    const admin = new objectId();
    await keystone.lists.Student.adapter.model.collection.insertOne({ _id: student, name: 'Student' });
    await keystone.lists.Parent.adapter.model.collection.insertOne({ _id: parent, name: 'Parent' });
    await keystone.lists.User.adapter.model.collection.insertOne({ _id: admin, name: 'Admin' });
    const domain = new FeeDomain(keystone);
    let sequence = 0;
    const create = changes => domain.create({ businessKey: `fee-${++sequence}`, source: 'MANUAL',
      type: 'TUITION', studentId: String(student), parentId: String(parent), billingMonth: '2026-09',
      schoolYear: '2026-2027', amount: 100000, evidence: { source: 'test' }, ...changes }, String(admin));

    await t.test('creates negative credit and rejects missing subject/duplicate business key', async () => {
      const credit = await create({ type: 'ABSENCE_CREDIT', amount: -50000, parentId: undefined });
      assert.equal(credit.status, 'ACTIVE');
      assert.equal(credit.amount, -50000);
      assert.equal(credit.attached, false);
      assert.equal(credit.createdBy, String(admin));
      const key = `fee-${sequence}`;
      await assert.rejects(create({ businessKey: key }), error => error.status === 409);
      await assert.rejects(create({ studentId: undefined, parentId: undefined }), error => error.status === 400);
    });

    await t.test('active link is unique, blocks cancellation, and detach permits cancellation', async () => {
      const fee = await create();
      const attached = await domain.attach(fee.id, { documentType: 'INVOICE', documentId: 'invoice-001' }, String(admin));
      assert.equal(attached.fee.attached, true);
      assert.equal(attached.fee.attachments[0].documentId, 'invoice-001');
      await assert.rejects(domain.attach(fee.id, { documentType: 'INVOICE', documentId: 'invoice-001' }, String(admin)),
        error => error.status === 409);
      await assert.rejects(domain.attach(fee.id, { documentType: 'MONTHLY_SETTLEMENT', documentId: 'month-other' }, String(admin)),
        error => error.status === 409);
      await assert.rejects(domain.cancel(fee.id, 'Không thu', String(admin)), error => error.status === 409);
      const detached = await domain.detach(fee.id, attached.linkId, 'Gắn nhầm', String(admin));
      assert.equal(detached.attached, false);
      const reattached = await domain.attach(fee.id, { documentType: 'INVOICE', documentId: 'invoice-001' }, String(admin));
      await domain.detach(fee.id, reattached.linkId, '', String(admin));
      const cancelled = await domain.cancel(fee.id, 'Miễn thu', String(admin));
      assert.equal(cancelled.status, 'CANCELLED');
      assert.equal(cancelled.cancelledBy, String(admin));
      assert.equal(cancelled.cancellationReason, 'Miễn thu');
      await assert.rejects(domain.attach(fee.id, { documentType: 'MONTHLY_SETTLEMENT', documentId: 'month-001' }, String(admin)),
        error => error.status === 409);
    });

    await t.test('concurrent attach and cancel cannot leave a cancelled attached fee', async () => {
      const fee = await create();
      const outcomes = await Promise.allSettled([
        domain.attach(fee.id, { documentType: 'ABSENCE_SETTLEMENT', documentId: 'absence-001' }, String(admin)),
        domain.cancel(fee.id, 'Concurrent cancellation', String(admin))
      ]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
      const current = await domain.get(fee.id);
      assert.equal(current.status === 'CANCELLED' && current.attached, false);
    });

    await t.test('list exposes derived attachment and bounded filtering', async () => {
      const result = await domain.list({ status: 'ACTIVE', billingMonth: '2026-09', pageSize: '10' });
      assert.ok(result.total >= 1);
      assert.ok(result.rows.every(row => row.status === 'ACTIVE'));
      await assert.rejects(domain.list({ pageSize: '101' }), error => error.status === 400);
    });
  } finally {
    try { if (keystone) await keystone.disconnect(); }
    finally { docker('stop', name); }
  }
});
