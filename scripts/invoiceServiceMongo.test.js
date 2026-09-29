const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { Keystone } = require('@keystonejs/keystone');
const { MongooseAdapter } = require('@keystonejs/adapter-mongoose');
const { Text, Relationship } = require('@keystonejs/fields');
const { InvoiceService, generateVietQrUrl } = require('../func/invoiceService');

const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
}).trim();

test('Invoice Service test suite (Admission & Retail with Fee linking)', { timeout: 180000 }, async t => {
  const name = `sme2-invoice-test-${process.pid}-${Date.now()}`;
  let keystone;

  docker('run', '-d', '--rm', '--name', name, '--tmpfs', '/data/db', '--tmpfs', '/data/configdb',
    'mongo:7.0', '--replSet', 'inv_fixture', '--bind_ip_all');

  try {
    const ip = docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
    let primary = false;
    for (let i = 0; i < 60; i++) {
      try {
        docker('exec', name, 'mongosh', '--quiet', '--eval',
          `try { rs.initiate({_id:'inv_fixture',members:[{_id:0,host:'${ip}:27017'}]}) } catch(e) {} if (!db.hello().isWritablePrimary) quit(2)`);
        primary = true;
        break;
      } catch (_) { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    assert.ok(primary, 'disposable replica set elected primary');

    keystone = new Keystone({
      name: 'inv-fixture',
      cookieSecret: 'fixture-only-cookie-secret',
      adapter: new MongooseAdapter({
        mongoUri: `mongodb://${ip}:27017/inv_fixture_${process.pid}?replicaSet=inv_fixture`,
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }),
    });

    for (const key of ['Parent', 'CashTransaction', 'PaymentSettlement', 'Log']) {
      keystone.createList(key, require(`../lists/${key}`));
    }
    keystone.createList('Phone', { fields: { parent: { type: Relationship, ref: 'Parent.phone' } } });
    keystone.createList('Student', { fields: { parent: { type: Relationship, ref: 'Parent.hocsinhs' } } });
    for (const key of ['User', 'HoaDon', 'Item', 'SanPham', 'PhieuKetSo', 'Variable']) {
      keystone.createList(key, { fields: { name: { type: Text }, key: { type: Text }, value: { type: Text } } });
    }
    keystone.createList('Fee', require('../lists/Fee'));
    keystone.createList('FeeDocumentLink', require('../lists/FeeDocumentLink'));

    await keystone.connect();
    keystone.createApolloServer({ schemaName: 'public' });
    const context = keystone.createContext({ skipAccessControl: true });

    const objectId = keystone.lists.Fee.adapter.model.db.base.Types.ObjectId;
    const admin = new objectId();
    await keystone.lists.User.adapter.model.collection.insertOne({ _id: admin, name: 'Admin Test' });

    const studentId = new objectId();
    const parentId = new objectId();
    await keystone.lists.Parent.adapter.model.collection.insertOne({
      _id: parentId,
      name: 'Phụ huynh Nguyễn Văn Bình',
      code: 'PH0001',
      debt: 0,
      balance: 0,
    });
    await keystone.lists.Student.adapter.model.collection.insertOne({
      _id: studentId,
      name: 'Bé Nguyễn Văn An',
      sName: 'AN001',
      status: 'DANG_HOC',
      parent: parentId,
    });

    const spUniformId = new objectId();
    await keystone.lists.SanPham.adapter.model.collection.insertOne({
      _id: spUniformId,
      name: 'Đồng phục mầm non',
      price: 150000,
    });

    const service = new InvoiceService(keystone);

    await t.test('generates VietQR URL with correct params', () => {
      const url = generateVietQrUrl('HD000123', 3500000);
      assert.ok(url.includes('77229966'));
      assert.ok(url.includes('HD000123'));
      assert.ok(url.includes('amount=3500000'));
    });

    await t.test('creates Admission Invoice with CSVC, multiple tuition months, and uniform', async () => {
      const result = await service.createAdmissionInvoice(
        context,
        {
          studentId: String(studentId),
          paymentMethod: 'CASH',
          facilityAmount: 2000000,
          schoolYear: '2026-2027',
          tuitionItems: [
            { billingMonth: '2026-09', amount: 1500000, note: 'Học phí nửa tháng 9' },
            { billingMonth: '2026-10', amount: 3000000, note: 'Học phí tháng 10 đóng trước' },
          ],
          productItems: [
            { sanphamId: String(spUniformId), name: 'Đồng phục mầm non', price: 150000, amount: 2, total: 300000 },
          ],
          discount: 200000,
          note: 'Hóa đơn nhập học bé An',
        },
        String(admin)
      );

      assert.equal(result.success, true);
      assert.ok(result.invoice);
      assert.equal(result.invoice.total, 6600000); // 2000000 + 1500000 + 3000000 + 300000 - 200000 = 6600000
      assert.equal(result.invoice.linkedFeesCount, 3); // CSVC + T9 + T10

      // Check linked fees in DB
      const fees = await keystone.lists.Fee.adapter.model.collection.find({ student: studentId }).toArray();
      assert.equal(fees.length, 3);

      const feeT9 = fees.find(f => f.billingMonth === '2026-09');
      assert.ok(feeT9);
      assert.equal(feeT9.amount, 1500000);
      assert.equal(feeT9.type, 'TUITION');

      const feeT10 = fees.find(f => f.billingMonth === '2026-10');
      assert.ok(feeT10);
      assert.equal(feeT10.amount, 3000000);
      assert.equal(feeT10.type, 'TUITION');

      const feeCsvc = fees.find(f => f.schoolYear === '2026-2027' && f.type === 'FACILITY');
      assert.ok(feeCsvc);
      assert.equal(feeCsvc.amount, 2000000);

      // Verify FeeDocumentLink
      const links = await keystone.lists.FeeDocumentLink.adapter.model.collection.find({
        documentId: String(result.invoice.id),
      }).toArray();
      assert.equal(links.length, 3);
    });

    await t.test('creates Retail Invoice for ad-hoc uniform purchase', async () => {
      const result = await service.createRetailInvoice(
        context,
        {
          studentId: String(studentId),
          paymentMethod: 'CASH',
          items: [
            { sanphamId: String(spUniformId), name: 'Đồng phục mầm non', price: 150000, amount: 1, total: 150000 },
          ],
          discount: 0,
        },
        String(admin)
      );

      assert.equal(result.success, true);
      assert.equal(result.invoice.total, 150000);
    });

    await t.test('fetches invoice detail with linked fees', async () => {
      const invoices = await keystone.lists.HoaDon.adapter.model.collection.find().toArray();
      assert.ok(invoices.length >= 2);
      const admissionInv = invoices[0];

      const detail = await service.getInvoiceDetail(context, String(admissionInv._id));
      assert.equal(detail.code, admissionInv.code);
      assert.equal(detail.fees.length, 3);
      assert.ok(detail.vietqrUrl.includes('77229966'));
    });
  } finally {
    try { if (keystone) await keystone.disconnect(); } catch (_) {}
    try { docker('rm', '-f', name); } catch (_) {}
  }
});
