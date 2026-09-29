const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { Keystone } = require('@keystonejs/keystone');
const { MongooseAdapter } = require('@keystonejs/adapter-mongoose');
const { Text } = require('@keystonejs/fields');
const { FeeGenerationService, calculateNextRunDate } = require('../func/feeGenerationService');

const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
}).trim();

test('Fee generation service test suite (Mongo disposable)', { timeout: 180000 }, async t => {
  const name = `sme2-fee-gen-test-${process.pid}-${Date.now()}`;
  let keystone;

  docker('run', '-d', '--rm', '--name', name, '--tmpfs', '/data/db', '--tmpfs', '/data/configdb',
    'mongo:7.0', '--replSet', 'fee_gen_fixture', '--bind_ip_all');

  try {
    const ip = docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
    let primary = false;
    for (let i = 0; i < 60; i++) {
      try {
        docker('exec', name, 'mongosh', '--quiet', '--eval',
          `try { rs.initiate({_id:'fee_gen_fixture',members:[{_id:0,host:'${ip}:27017'}]}) } catch(e) {} if (!db.hello().isWritablePrimary) quit(2)`);
        primary = true;
        break;
      } catch (_) { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    assert.ok(primary, 'disposable replica set elected primary');

    keystone = new Keystone({
      name: 'fee-gen-fixture',
      cookieSecret: 'fixture-only-cookie-secret',
      adapter: new MongooseAdapter({
        mongoUri: `mongodb://${ip}:27017/fee_gen_fixture_${process.pid}?replicaSet=fee_gen_fixture`,
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }),
    });

    for (const key of ['Student', 'Parent', 'Phone', 'Variable', 'LopHoc', 'User']) {
      keystone.createList(key, { fields: { name: { type: Text }, key: { type: Text }, value: { type: Text } } });
    }
    keystone.createList('Fee', require('../lists/Fee'));
    keystone.createList('FeeDocumentLink', require('../lists/FeeDocumentLink'));
    keystone.createList('FeeDefinition', require('../lists/FeeDefinition'));
    keystone.createList('FeeGenerationRun', require('../lists/FeeGenerationRun'));
    await keystone.connect();

    const objectId = keystone.lists.Fee.adapter.model.db.base.Types.ObjectId;
    const admin = new objectId();
    await keystone.lists.User.adapter.model.collection.insertOne({ _id: admin, name: 'Admin Test' });

    const service = new FeeGenerationService(keystone);

    await t.test('calculates next run date correctly in Vietnam timezone', () => {
      const nextRun = calculateNextRunDate(25, 1, new Date('2026-09-20T10:00:00Z'));
      assert.ok(nextRun > new Date('2026-09-20T10:00:00Z'));
    });

    await t.test('initializes default fee definitions if not present', async () => {
      await service.ensureDefaultDefinitions(String(admin));
      const defs = await service.listDefinitions();
      assert.ok(defs.length >= 4);
      assert.ok(defs.some(d => d.code === 'TUITION_MONTHLY'));
      assert.ok(defs.some(d => d.code === 'CAMERA_MONTHLY'));
    });

    await t.test('generates tuition fees and prevents duplicate generation on rerun', async () => {
      const studentId = new objectId();
      const parentId = new objectId();
      await keystone.lists.Student.adapter.model.collection.insertOne({
        _id: studentId,
        name: 'Bé Nguyễn An',
        status: 'DANG_HOC',
        namhocphi: 'HPN_2026',
        hocphigiam: '200000',
        parent: parentId,
      });
      await keystone.lists.Parent.adapter.model.collection.insertOne({
        _id: parentId,
        name: 'Phụ huynh Nguyễn Văn Bình',
      });
      await keystone.lists.Variable.adapter.model.collection.insertOne({
        _id: new objectId(),
        key: 'HPN_2026',
        value: '3000000',
      });

      const defs = await service.listDefinitions();
      const tuitionDef = defs.find(d => d.code === 'TUITION_MONTHLY');

      // 1. Dry run preview
      const preview = await service.runDefinition(tuitionDef.id, { billingMonth: '2026-10', dryRun: true }, String(admin));
      assert.equal(preview.isDryRun, true);
      assert.equal(preview.createdCount, 1);
      assert.equal(preview.items[0].amount, 2800000);

      // 2. Real run
      const run1 = await service.runDefinition(tuitionDef.id, { billingMonth: '2026-10', dryRun: false }, String(admin));
      assert.equal(run1.createdCount, 1);
      assert.equal(run1.status, 'SUCCESS');

      // 3. Rerun same month -> ALREADY_EXISTS, createdCount = 0
      const run2 = await service.runDefinition(tuitionDef.id, { billingMonth: '2026-10', dryRun: false }, String(admin));
      assert.equal(run2.createdCount, 0);
      assert.equal(run2.skippedCount, 1);
      assert.equal(run2.items[0].status, 'ALREADY_EXISTS');
    });

    await t.test('generates camera fee based on parent phones', async () => {
      const parentId = new objectId();
      const studentId = new objectId();
      await keystone.lists.Parent.adapter.model.collection.insertOne({
        _id: parentId,
        name: 'PH Trần Văn Hùng',
        code: 'PH00099',
      });
      await keystone.lists.Student.adapter.model.collection.insertOne({
        _id: studentId,
        name: 'Bé Trần Minh',
        status: 'DANG_HOC',
        parent: parentId,
      });
      // 3 phone numbers
      await keystone.lists.Phone.adapter.model.collection.insertMany([
        { _id: new objectId(), parent: parentId, number: '0901111111' },
        { _id: new objectId(), parent: parentId, number: '0902222222' },
        { _id: new objectId(), parent: parentId, number: '0903333333' },
      ]);

      const defs = await service.listDefinitions();
      const cameraDef = defs.find(d => d.code === 'CAMERA_MONTHLY');

      const runCam = await service.runDefinition(cameraDef.id, { billingMonth: '2026-10', dryRun: false }, String(admin));
      // 3 phones - 1 free = 2 billable * 50,000 = 100,000đ
      assert.ok(runCam.createdCount >= 1);
      const item = runCam.items.find(i => String(i.targetId) === String(parentId));
      assert.equal(item.amount, 100000);
      assert.equal(item.status, 'CREATED');
    });

    await t.test('manual bulk creation generates fees for selected recipients', async () => {
      const studentId = new objectId();
      await keystone.lists.Student.adapter.model.collection.insertOne({
        _id: studentId,
        name: 'Bé Lê Hoàng',
        status: 'DANG_HOC',
      });

      const res = await service.createManualBulk({
        feeType: 'FACILITY',
        studentIds: [String(studentId)],
        amount: 2000000,
        schoolYear: '2026-2027',
        reason: 'Cơ sở vật chất đóng năm',
      }, String(admin));

      assert.equal(res.success, true);
      assert.equal(res.createdCount, 1);
      assert.equal(res.createdFees[0].amount, 2000000);
    });

    await t.test('listRuns and getRunDetail expose run logs', async () => {
      const runs = await service.listRuns({ limit: 10 });
      assert.ok(runs.total >= 2);
      const detail = await service.getRunDetail(runs.rows[0].id);
      assert.ok(detail.code);
      assert.ok(Array.isArray(detail.items));
    });

  } finally {
    try { if (keystone) await keystone.disconnect(); }
    finally { docker('stop', name); }
  }
});
