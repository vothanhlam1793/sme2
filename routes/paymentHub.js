const express = require('express');
const { gql } = require('apollo-server-express');
const SettlementService = require('../func/settlement');
const { access } = require('../setting/access');
const security = require('./paymentHubSecurity');
const { repositoryFor } = require('../func/accountingMongo');
const SchoolFund = require('../func/schoolFund');
const { FeeDomain } = require('../func/feeDomain');
const { FeeGenerationService } = require('../func/feeGenerationService');
const { InvoiceService } = require('../func/invoiceService');
const WithdrawalSettlementService = require('../func/withdrawalSettlementService');

function createPaymentHubRouter(keystone, { contextFactory = options => keystone.createContext(options) } = {}) {
  const router = express.Router();
  // Trusted constructor seam only; requests cannot select or bind a repository.
  const systemContext = () => contextFactory({ skipAccessControl: true });
  const userContext = req => contextFactory({
    authentication: { item: req.user, listKey: req.authedListKey }
  });
  const handle = fn => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err.code === 'ACCOUNTING_CONFLICT') return res.status(409).json({ success: false,
        error: 'Yêu cầu xung đột với dữ liệu kế toán' });
      if (!err.status || err.status >= 500) {
        console.error('[PaymentHub Handler Error]:', err);
      }
      res.status(err.status || 500).json({ success: false,
        error: err.status ? err.message : 'Không thể hoàn tất thao tác thanh toán' });
    }
  };
  async function execute(context, query, variables) {
    const result = await context.executeGraphQL({ context, query, variables });
    if (result.errors?.length || !result.data) throw new Error('PaymentHub GraphQL operation failed');
    return result.data;
  }
  async function setting(context) {
    const data = await execute(context, gql`query {
      allSystemSettings(where: { key: "MONAPAY_CONFIG" }) { id value }
    }`);
    const row = data.allSystemSettings?.[0];
    return { id: row?.id, config: { ...security.defaults, ...(row ? JSON.parse(row.value) : {}) } };
  }
  async function save(context, id, config) {
    const value = JSON.stringify(config);
    const data = id ? await execute(context, gql`mutation ($id: ID!, $value: String!) {
      updateSystemSetting(id: $id, data: { value: $value, isSecret: true }) { id }
    }`, { id, value }) : await execute(context, gql`mutation ($value: String!) {
      createSystemSetting(data: { key: "MONAPAY_CONFIG", value: $value, isSecret: true,
        description: "Cấu hình cổng thanh toán MONA Pay" }) { id }
    }`, { value });
    if (!(data.updateSystemSetting || data.createSystemSetting)?.id) throw new Error('Setting write failed');
  }

  router.get('/monapay-webhook', (req, res) => res.json({ status: 'ok', service: 'monapay-webhook-hub' }));
  router.post('/monapay-webhook', express.json({ limit: '100kb', inflate: false,
    verify: (req, res, buf) => { req.rawBody = buf; }
  }), handle(async (req, res) => {
    const context = systemContext();
    const { config } = await setting(context);
    if (config.monapay_enabled !== true) security.fail('MONA Pay Hub đang tắt', 403);
    security.verifyWebhook(req, config.webhook_secret, Date.now(), config.webhook_max_age_seconds);
    const item = security.inbound(req.body, config);
    const result = await ingest(context, item, config);
    res.json({ success: true, data: result });
  }));

  // configureExpress mounts this router BEFORE Keystone's global session stack.
  // Use the existing cookie/Bearer session validation and backend admin policy.
  const management = express.Router();
  management.use(keystone._sessionManager.getSessionMiddleware({ keystone }));
  management.use((req, res, next) => {
    if (!req.user || req.authedListKey !== 'User') return res.status(401).json({ success: false, error: 'Cần đăng nhập' });
    if (!access.userIsAdmin({ authentication: { item: req.user } })) return res.status(403).json({ success: false, error: 'Cần quyền quản trị' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  management.use(express.json({ limit: '100kb' }));
  const feeDomain = () => new FeeDomain(keystone);
  const feeGenService = () => new FeeGenerationService(keystone);
  const invoiceService = () => new InvoiceService(keystone);
  const withdrawalService = () => new WithdrawalSettlementService(keystone);

  management.post('/invoices/admission', handle(async (req, res) => {
    const service = invoiceService();
    const result = await service.createAdmissionInvoice(userContext(req), req.body, req.user.id || req.user._id);
    res.status(201).json(result);
  }));

  management.post('/invoices/retail', handle(async (req, res) => {
    const service = invoiceService();
    const result = await service.createRetailInvoice(userContext(req), req.body, req.user.id || req.user._id);
    res.status(201).json(result);
  }));

  management.get('/invoices/:id', handle(async (req, res) => {
    const service = invoiceService();
    const result = await service.getInvoiceDetail(userContext(req), req.params.id);
    res.json({ success: true, data: result });
  }));

  // WITHDRAWAL SETTLEMENT (KẾT SỔ NGHỈ HỌC)
  management.get('/settlements/withdrawal-preview', handle(async (req, res) => {
    const { studentId, month, year } = req.query;
    if (!studentId) return res.status(400).json({ success: false, error: 'Thiếu studentId' });
    const result = await withdrawalService().getWithdrawalPreview(userContext(req), { studentId, month, year });
    res.json({ success: true, data: result });
  }));

  management.post('/settlements/withdrawal', handle(async (req, res) => {
    const result = await withdrawalService().executeWithdrawalSettlement(userContext(req), req.body || {}, req.user?.id || req.user?._id);
    res.json(result);
  }));

  management.get('/fee-definitions', handle(async (req, res) => {
    const service = feeGenService();
    await service.ensureDefaultDefinitions(req.user.id || req.user._id);
    res.json({ success: true, data: await service.listDefinitions() });
  }));

  management.post('/fee-definitions', handle(async (req, res) => {
    const service = feeGenService();
    const data = await service.createDefinition(req.body, req.user.id || req.user._id);
    res.status(201).json({ success: true, data });
  }));

  management.put('/fee-definitions/:id', handle(async (req, res) => {
    const service = feeGenService();
    const data = await service.updateDefinition(req.params.id, req.body, req.user.id || req.user._id);
    res.json({ success: true, data });
  }));

  management.post('/fee-definitions/:id/run', handle(async (req, res) => {
    const service = feeGenService();
    const result = await service.runDefinition(req.params.id, req.body || {}, req.user.id || req.user._id);
    res.json({ success: true, data: result });
  }));

  management.get('/fee-runs', handle(async (req, res) => {
    const service = feeGenService();
    res.json({ success: true, data: await service.listRuns(req.query) });
  }));

  management.get('/fee-runs/:id', handle(async (req, res) => {
    const service = feeGenService();
    res.json({ success: true, data: await service.getRunDetail(req.params.id) });
  }));

  management.post('/fees/manual-bulk', handle(async (req, res) => {
    const service = feeGenService();
    const result = await service.createManualBulk(req.body, req.user.id || req.user._id);
    res.json({ success: true, data: result });
  }));

  management.get('/fees', handle(async (req, res) => {
    res.json({ success: true, data: await feeDomain().list(req.query) });
  }));
  management.post('/fees', handle(async (req, res) => {
    const data = await feeDomain().create(req.body, req.user.id || req.user._id);
    res.status(201).json({ success: true, data });
  }));
  management.post('/fees/:feeId/cancel', handle(async (req, res) => {
    const data = await feeDomain().cancel(req.params.feeId, req.body?.reason, req.user.id || req.user._id);
    res.json({ success: true, data });
  }));
  management.post('/fees/:feeId/attachments', handle(async (req, res) => {
    const data = await feeDomain().attach(req.params.feeId, req.body, req.user.id || req.user._id);
    res.status(201).json({ success: true, data });
  }));
  management.delete('/fees/:feeId/attachments/:attachmentId', handle(async (req, res) => {
    const data = await feeDomain().detach(req.params.feeId, req.params.attachmentId, req.body?.reason,
      req.user.id || req.user._id);
    res.json({ success: true, data });
  }));
  async function fundSetup(context) {
    const data = await execute(context, gql`query { allSystemSettings(where: { key: "SCHOOL_FUND_SETUP" }) { id value } }`);
    const rows = data.allSystemSettings || [];
    if (rows.length > 1) throw new Error('Duplicate fund setup');
    return rows[0];
  }
  management.get('/school-fund/settings', handle(async (req, res) => {
    const row = await fundSetup(userContext(req));
    res.json({ success: true, data: row ? JSON.parse(row.value) : null });
  }));
  management.post('/school-fund/settings', handle(async (req, res) => {
    const { startDate, openingCash, note = '' } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !Number.isFinite(Date.parse(startDate)) ||
        new Date(startDate).toISOString().slice(0, 10) !== startDate ||
        !Number.isSafeInteger(openingCash) || Math.abs(openingCash) > 2147483647 ||
        typeof note !== 'string' || note.length > 1000) return res.status(400).json({ success: false, error: 'Ngày hoặc số dư không hợp lệ' });
    const context = userContext(req);
    if (keystone.lists?.PaymentSettlement?.adapter?.model && await new SchoolFund(keystone).funds.findOne({ _id: 'school' })) {
      return res.status(409).json({ success: false, error: 'Quỹ đã khởi tạo; dùng phiếu nộp/rút để thay đổi số dư' });
    }
    const row = await fundSetup(context);
    if (row && JSON.parse(row.value).status !== 'DRAFT') return res.status(409).json({ success: false, error: 'Số đầu đã chốt; cần lập phiếu điều chỉnh' });
    const config = { startDate, openingCash, note: note.trim(), status: 'DRAFT', updatedBy: String(req.user.id || req.user._id), updatedAt: new Date().toISOString() };
    const value = JSON.stringify(config);
    const result = row ? await execute(context, gql`mutation ($id: ID!, $value: String!) {
      updateSystemSetting(id: $id, data: { value: $value }) { id }
    }`, { id: row.id, value }) : await execute(context, gql`mutation ($value: String!) {
      createSystemSetting(data: { key: "SCHOOL_FUND_SETUP", value: $value, description: "Thiết lập số đầu quỹ trường", isSecret: false }) { id }
    }`, { value });
    if (!(result.updateSystemSetting || result.createSystemSetting)?.id) throw new Error('Setup write failed');
    res.json({ success: true, data: config });
  }));
  management.post('/school-fund/initialize', handle(async (req, res) => {
    const row = await fundSetup(userContext(req));
    if (!row) return res.status(400).json({ success: false, error: 'Lưu cài đặt quỹ trước khi khởi tạo' });
    const service = new SchoolFund(keystone);
    await service.initialize(JSON.parse(row.value), String(req.user.id || req.user._id));
    res.json({ success: true, data: await service.summary() });
  }));
  function fundRepository(req, res) {
    const repo = repositoryFor(userContext(req));
    return repo;
  }
  function fundRange(query) {
    const from = query.from, to = query.to;
    if (!from && !to) return null;
    const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(`${value}T00:00:00+07:00`).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) === value;
    if (!valid(from) || !valid(to)) { const error = new Error('Khoảng thời gian không hợp lệ'); error.status = 400; throw error; }
    const fromDate = new Date(`${from}T00:00:00+07:00`);
    const toDate = new Date(`${to}T00:00:00+07:00`);
    if (fromDate > toDate) { const error = new Error('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc'); error.status = 400; throw error; }
    const next = new Date(toDate); next.setUTCDate(next.getUTCDate() + 1);
    return { from: fromDate, toExclusive: next, fromText: from, toText: to };
  }
  management.get('/school-fund', handle(async (req, res) => {
    const repo = fundRepository(req, res);
    const raw = Number(req.query.page || 1);
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > 100000) return res.status(400).json({ success: false, error: 'Trang không hợp lệ' });
    const range = fundRange(req.query);
    if (!repo) return res.json({ success: true, data: await new SchoolFund(keystone).summary(raw, range) });
    // Single snapshot: displayed balance and ledger page describe the same revision.
    const session = await repo.connection.startSession();
    let data;
    try {
      await session.withTransaction(async () => {
        const fund = await repo.schoolFund.findOne({ _id: 'school' }, { session });
        const match = range ? { createdAt: { $gte: range.from, $lt: range.toExclusive } } : {};
        const rows = await repo.fundEntries.find(match, { session }).sort({ createdAt: -1, _id: -1 }).skip((raw - 1) * 50).limit(50).toArray();
        const total = await repo.fundEntries.countDocuments(match, { session });
        const movement = await repo.fundEntries.aggregate([{ $match: match }, { $group: { _id: null,
          income: { $sum: { $cond: [{ $gt: ['$delta', 0] }, '$delta', 0] } },
          expense: { $sum: { $cond: [{ $lt: ['$delta', 0] }, { $abs: '$delta' }, 0] } }, net: { $sum: '$delta' } } }], { session }).toArray();
        const period = movement[0] || { income: 0, expense: 0, net: 0 };
        data = { cash: fund.cash, revision: fund.revision, page: raw, pageSize: 50, total, rows,
          periodIncome: period.income, periodExpense: period.expense, periodNet: period.net,
          from: range && range.fromText, to: range && range.toText };
      }, { readConcern: { level: 'snapshot' } });
    } finally { await session.endSession(); }
    if (data && data.rows && data.rows.length) {
      const userIds = [...new Set(data.rows.map(r => r.userId).filter(Boolean))];
      try {
        const users = await repo.collections.User.find({ _id: { $in: userIds.map(id => repo.id(id)) } }).toArray();
        const userMap = new Map(users.map(u => [String(u._id), u.name]));
        data.rows = data.rows.map(r => ({
          ...r,
          createdByName: r.userId ? (userMap.get(String(r.userId)) || 'Nhân viên') : 'Hệ thống'
        }));
      } catch (_) {}
    }
    res.json({ success: true, data });
  }));
  management.post('/school-fund/vouchers', handle(async (req, res) => {
    const repo = fundRepository(req, res);
    const { operationId, type, amount, reason, counterparty } = req.body;
    if (!repo) return res.json({ success: true, data: await new SchoolFund(keystone).post({ operationId, type, amount, reason, counterparty, userId: String(req.user.id || req.user._id) }) });
    const data = await repo.fundVoucher({ operationId, type, amount, reason, counterparty, userId: String(req.user.id || req.user._id) });
    res.json({ success: true, data });
  }));
  management.post('/school-fund/reversals', handle(async (req, res) => {
    const repo = fundRepository(req, res);
    const { operationId, voucherId, reason } = req.body;
    if (!repo) return res.json({ success: true, data: await new SchoolFund(keystone).post({ operationId, voucherId, reason, userId: String(req.user.id || req.user._id) }, true) });
    const data = await repo.reverseFundVoucher({ operationId, voucherId, reason, userId: String(req.user.id || req.user._id) });
    res.json({ success: true, data });
  }));
  management.get('/config', handle(async (req, res) => {
    const { config } = await setting(userContext(req));
    res.json({ success: true, data: { ...security.publicConfig(config),
      webhook_url: `${req.protocol}://${req.get('host')}/api/payment-hub/monapay-webhook` } });
  }));
  management.post('/config', handle(async (req, res) => {
    const context = userContext(req);
    const { id, config } = await setting(context);
    await save(context, id, security.mergeConfig(config, req.body));
    res.json({ success: true, message: 'Đã lưu cấu hình MONA Pay thành công' });
  }));

  async function ingest(context, item, config) {
    // Preserve production legacy behavior until cutover. Explicitly bound native
    // contexts must replay/validate the durable outcome, never this bankRef shortcut.
    if (!repositoryFor(context)) {
      const existing = await execute(context, gql`query ($bankRef: String!) {
        allCashTransactions(where: { bankRef: $bankRef }) { id }
      }`, { bankRef: item.bankRef });
      if (existing.allCashTransactions?.length) return {
        success: true, duplicate: true, cashTransaction: existing.allCashTransactions[0]
      };
    }
    const match = item.description.match(/PH\d{4,8}/i);
    let parentId = null;
    if (match) {
      const data = await execute(context, gql`query ($code: String!) {
        allParents(where: { code: $code }) { id }
      }`, { code: match[0].toUpperCase() });
      parentId = data.allParents?.[0]?.id || null;
    }
    // Atomic deduplication belongs to SettlementService. Keep references identical
    // across webhook, polling and manual fallback; never use delivery/checkout IDs.
    const result = await SettlementService.processInflowAndSettle(context, {
      parentId, amount: item.amount, paymentMethod: 'MONA_PAY', bankRef: item.bankRef,
      providerReference: item.providerReference, receivingAccount: item.receivingAccount,
      bankDescription: item.bankDescription, settleType: 'AUTO_ACB', autoSettle: config.auto_settle !== false
    });
    if (!result || result.success === false) throw new Error('Settlement failed');
    return result;
  }
  let syncRunning = false;
  async function sync(context) {
    if (syncRunning) security.fail('Đồng bộ đang chạy', 409);
    syncRunning = true;
    const result = { success: false, lastSync: new Date().toISOString(), syncedCount: 0, totalChecked: 0 };
    try {
      const { config } = await setting(context);
      result.coverage = config.virtual_account_numbers?.length ? 'configured_va_transactions' : 'webhook_log_recovery';
      result.fullBankReconciliation = false;
      const items = await security.fetchTransactions(config);
      result.totalChecked = items.length;
      for (const item of items) {
        const settled = await ingest(context, item, config);
        if (!settled.duplicate) result.syncedCount++;
      }
      result.success = true;
      result.message = 'Hoàn tất quét nguồn đã cấu hình; không phải đối soát toàn bộ ngân hàng';
    } catch (err) {
      result.error = err.status ? err.message : 'Đồng bộ thất bại; kiểm tra cấu hình và dịch vụ';
    } finally {
      try {
        const { id, config } = await setting(context);
        await save(context, id, { ...config, last_sync_at: result.lastSync, last_sync_result: result });
      } catch (_) {
        result.success = false;
        result.error = 'Không thể lưu trạng thái đồng bộ';
      }
      syncRunning = false;
    }
    return result;
  }
  management.post('/sync', handle(async (req, res) => {
    const result = await sync(userContext(req));
    res.status(result.success ? 200 : 502).json(result);
  }));
  management.post('/assign-parent', handle(async (req, res) => {
    const { cashTxId, cashTxData, parentId, autoSettle = true, note = '', isNewTx = false } = req.body || {};
    if (!security.text(parentId) || typeof autoSettle !== 'boolean' || typeof isNewTx !== 'boolean' || typeof note !== 'string' || note.length > 4096) security.fail('Dữ liệu gán phụ huynh không hợp lệ');
    const context = userContext(req);
    let result;
    if (isNewTx) {
      if (!cashTxData || typeof cashTxData !== 'object' || Array.isArray(cashTxData)) security.fail('Thiếu dữ liệu dòng tiền');
      const amount = security.amount(cashTxData.amount);
      const paymentMethod = cashTxData.paymentMethod || 'CASH';
      if (!['CASH', 'ACB_BANK', 'MONA_PAY', 'OTHER'].includes(paymentMethod)) security.fail('Phương thức thanh toán không hợp lệ');
      if (['ACB_BANK', 'MONA_PAY'].includes(paymentMethod) && !security.text(cashTxData.bankRef, 100)) security.fail('Chuyển khoản cần bankRef');
      if (cashTxData.bankRef != null && !security.text(cashTxData.bankRef, 100)) security.fail('bankRef không hợp lệ');
      if (cashTxData.bankDescription != null && (typeof cashTxData.bankDescription !== 'string' || cashTxData.bankDescription.length > 4096)) security.fail('Nội dung không hợp lệ');
      let receivingAccount = cashTxData.receivingAccount;
      if (['ACB_BANK', 'MONA_PAY'].includes(paymentMethod)) {
        const { config } = await setting(context);
        const verified = security.inbound({ amount, type: 'income', transaction_code: cashTxData.bankRef,
          account_number: receivingAccount, bank_name: config.default_bank,
          description: cashTxData.bankDescription, is_sandbox: cashTxData.is_sandbox }, config);
        receivingAccount = verified.receivingAccount;
      }
      result = await SettlementService.processInflowAndSettle(context, {
        parentId, amount, paymentMethod, bankRef: cashTxData.bankRef,
        providerReference: cashTxData.bankRef, receivingAccount,
        bankDescription: cashTxData.bankDescription, settleType: 'MANUAL_ACCOUNTANT',
        autoSettle, note: note || cashTxData.bankDescription, userId: req.user.id
      });
    } else {
      if (!security.text(cashTxId)) security.fail('Thiếu ID dòng tiền');
      result = await SettlementService.allocateCashTransaction(context, { cashTxId, parentId, autoSettle, note, userId: req.user.id });
    }
    if (!result || result.success === false) throw new Error('Settlement failed');
    // Existing assignment UI reads remainingBalance/remainingDebt at top level.
    res.json(isNewTx ? { success: true, data: result } : result);
  }));
  router.use(management);
  router.use((err, req, res, next) => {
    res.status(err.status || 500).json({ success: false, error: 'Yêu cầu không hợp lệ' });
  });

  let lastAttempt = 0;
  const timer = setInterval(async () => {
    if (syncRunning) return;
    try {
      const context = systemContext();
      const { config } = await setting(context);
      const minutes = Number.isInteger(config.auto_sync_interval_mins) && config.auto_sync_interval_mins >= 1 ? config.auto_sync_interval_mins : 15;
      if (security.canSync(config) && Date.now() - lastAttempt >= minutes * 60000) {
        lastAttempt = Date.now();
        await sync(context);
      }
    } catch (_) { console.warn('[PaymentHub] Auto-sync failed'); }
  }, 60000);
  timer.unref();
  return router;
}
module.exports = createPaymentHubRouter;
