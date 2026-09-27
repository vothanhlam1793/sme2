// Explicit operator task approved in conversation; never changes source settlements.
require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });
const { MongoClient } = require('mongodb');
const Fund = require('../func/schoolFund');
(async () => {
  const client = await MongoClient.connect(process.env.MONGO_URL, {
    useNewUrlParser: true, useUnifiedTopology: true,
    ...(process.env.MONGO_USER ? { auth: { user: process.env.MONGO_USER, password: process.env.MONGO_PASS }, authSource: process.env.MONGO_AUTH_SOURCE || 'admin' } : {})
  });
  try {
    const db = client.db();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name);
    const locate = name => {
      const found = names.filter(n => n.toLowerCase() === name.toLowerCase());
      if (found.length !== 1) throw new Error(`Expected one collection for ${name}`);
      return db.collection(found[0]);
    };
    const settings = locate('systemsettings'), settlements = locate('paymentsettlements');
    const rows = await settings.find({ key: 'SCHOOL_FUND_SETUP' }).toArray();
    if (rows.length !== 1) throw new Error('Expected saved fund setup');
    const saved = JSON.parse(rows[0].value);
    if (!Number.isSafeInteger(saved.openingCash)) throw new Error('Saved opening cash invalid');
    const service = new Fund({ lists: { PaymentSettlement: { adapter: { model: { collection: settlements, db } } } } });
    const existing = await service.funds.findOne({ _id: 'school' });
    if (existing && (existing.startDate !== '2026-09-01' || existing.openingCash !== saved.openingCash)) throw new Error('Existing fund differs; not overwriting');
    const source = await service.sources();
    const missing = source.filter(r => !r.at || !Number.isFinite(new Date(r.at).getTime()));
    const approval = { confirmedAt: new Date().toISOString(), executedBy: 'opencode:user-authorized',
      reason: 'User confirmed undated settlements are included in opening balance before 2026-09-01',
      settlementIds: missing.map(r => r.id) };
    const setup = { ...saved, startDate: '2026-09-01', approvedUndatedIds: approval.settlementIds, openingApproval: approval };
    console.log(JSON.stringify({ database: db.databaseName, startDate: setup.startDate, openingCash: saved.openingCash,
      undatedCount: missing.length, undatedSuccessfulTotal: missing.filter(r => r.status === 'SUCCESS').reduce((s,r) => s+r.amount,0) }));
    if (!process.argv.includes('--apply')) return;
    await service.initialize(setup, 'opencode:user-authorized');
    await settings.updateOne({ _id: rows[0]._id, value: rows[0].value }, { $set: { value: JSON.stringify({ ...setup, status: 'INITIALIZED' }) } });
    const summary = await service.summary();
    const fund = await service.funds.findOne({ _id: 'school' });
    console.log(JSON.stringify({ initialized: true, startDate: fund.startDate, openingCash: fund.openingCash,
      cash: summary.cash, entries: summary.total, approvedUndatedCount: fund.baseline.filter(r => r.openingClassification === 'UNDATED_INCLUDED_BY_USER_CONFIRMATION').length }));
  } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
