const crypto = require('crypto');
const invalid = message => { const e = new Error(message); e.status = 409; throw e; };
const amount = n => { if (!Number.isSafeInteger(n)) invalid('Số tiền không hợp lệ'); return n; };
const required = value => { if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid('Thiếu mã yêu cầu, lý do hoặc người nhận/giao'); return value.trim(); };

// Operational fund: settlement documents remain the authority for earned cash.
// The singleton holds opening evidence and immutable manual vouchers. CAS serializes
// manual commands without requiring transactions on the legacy Mongo deployment.
class SchoolFund {
  constructor(keystone) {
    const model = keystone.lists.PaymentSettlement.adapter.model;
    this.settlements = model.collection;
    this.funds = model.db.collection('school_operating_fund_v1');
    this.entries = model.db.collection('school_operating_fund_entries_v2');
    this.db = model.db;
  }
  source(row) {
    const rawAt = row.settledAt_utc || row.settledAt || row.createdAt;
    let at = null;
    if (rawAt) {
      const date = new Date(rawAt);
      if (Number.isFinite(date.getTime())) at = date;
    }
    return { id: String(row._id), code: row.code, amount: amount(row.amount || 0), status: row.status, at,
      userId: row.settledBy ? String(row.settledBy) : null, parentId: row.parent ? String(row.parent) : null,
      settleType: row.settleType, note: row.note };
  }
  async sources() {
    const rows = await this.settlements.find({}).toArray();
    return rows.map(row => this.source(row));
  }
  async resolveNames(fund, sources) {
    const parentMap = new Map();
    const userMap = new Map();
    if (!this.db) return { parents: parentMap, users: userMap };

    const parentIds = new Set();
    const userIds = new Set();

    if (fund && fund.createdBy) userIds.add(String(fund.createdBy));
    for (const v of (fund && fund.vouchers) || []) {
      if (v.userId) userIds.add(String(v.userId));
    }
    for (const s of sources || []) {
      if (s.parentId) parentIds.add(String(s.parentId));
      if (s.userId) userIds.add(String(s.userId));
    }

    const toQuery = ids => {
      let ObjectId;
      try { ObjectId = require('mongodb').ObjectId; } catch (_) {}
      return [...ids].map(id => {
        try {
          return ObjectId && ObjectId.isValid(id) ? new ObjectId(id) : id;
        } catch (_) {
          return id;
        }
      });
    };

    try {
      if (parentIds.size > 0) {
        const pCol = this.db.collection('parents');
        const parents = await pCol.find({ _id: { $in: toQuery(parentIds) } }, { projection: { name: 1 } }).toArray();
        for (const p of parents) {
          parentMap.set(String(p._id), p.name);
        }
      }
    } catch (_) {}

    try {
      if (userIds.size > 0) {
        const uCol = this.db.collection('users');
        const users = await uCol.find({ _id: { $in: toQuery(userIds) } }, { projection: { name: 1 } }).toArray();
        for (const u of users) {
          userMap.set(String(u._id), u.name);
        }
      }
    } catch (_) {}

    return { parents: parentMap, users: userMap };
  }
  async initialize(setup, userId) {
    const existing = await this.funds.findOne({ _id: 'school' });
    if (existing) return existing;
    const date = `${setup.startDate}T00:00:00+07:00`;
    const cutoff = new Date(date);
    if (!Number.isFinite(cutoff.getTime()) || cutoff > new Date()) invalid('Ngày bắt đầu phải là hôm nay hoặc trước đó');
    const source = await this.sources();
    const undated = row => !row.at || !Number.isFinite(new Date(row.at).getTime());
    const approved = new Set(setup.approvedUndatedIds || []);
    if (source.some(row => undated(row) && !approved.has(row.id))) invalid('Có phiếu thanh toán thiếu ngày hợp lệ; cần đối soát trước khi khởi tạo');
    const baseline = source.filter(row => undated(row) || new Date(row.at) < cutoff).map(row => ({ ...row,
      openingClassification: undated(row) ? 'UNDATED_INCLUDED_BY_USER_CONFIRMATION' : 'BEFORE_START',
      value: row.status === 'SUCCESS' ? row.amount : 0 }));
    const row = { _id: 'school', revision: 0, openingCash: amount(setup.openingCash), startDate: setup.startDate,
      createdAt: new Date(), createdBy: userId, note: setup.note || '', baseline, vouchers: [],
      openingApproval: setup.openingApproval || null };
    try { await this.funds.insertOne(row); } catch (e) { if (e.code !== 11000) throw e; }
    const fund = await this.funds.findOne({ _id: 'school' });
    await this.rebuildEntries(fund);
    return fund;
  }
  settlementEntry(row, fund) {
    const old = new Map(fund.baseline.map(item => [item.id, item])).get(row.id);
    const delta = amount((row.status === 'SUCCESS' ? row.amount : 0) - (old ? old.value : 0));
    if (!delta || !row.at) return null;
    const labels = { AUTO_ACB: 'Cấn trừ tự động ACB', MANUAL_ACCOUNTANT: 'Kế toán gạch nợ học phí',
      SCHOOL_TRANSFER: 'Trường chuyển cấn trừ ví', PARENT_TRANSFER: 'Phụ huynh chuyển cấn trừ', WALLET_DEDUCT: 'Trừ số dư ví' };
    return { _id: `settlement:${row.id}`, code: row.code, type: 'SETTLEMENT', delta, effectiveAt: row.at,
      createdAt: row.at, userId: row.userId, parentId: row.parentId, reason: row.note || labels[row.settleType] ||
        (old ? 'Chênh lệch thanh toán trước kỳ' : 'Thanh toán công nợ'), sourceId: row.id };
  }
  voucherEntry(row) {
    return { ...row, effectiveAt: new Date(row.createdAt), createdAt: new Date(row.createdAt) };
  }
  async ensureIndexes() {
    await this.entries.createIndex({ effectiveAt: -1, _id: -1 });
    await this.entries.createIndex({ sourceId: 1 });
  }
  async rebuildEntries(fund) {
    if (!fund) return;
    await this.ensureIndexes();
    const sources = await this.sources();
    const rows = [{ _id: 'opening', code: 'QD-DAUKY', type: 'OPENING', delta: fund.openingCash,
      effectiveAt: new Date(`${fund.startDate}T00:00:00+07:00`), createdAt: new Date(`${fund.startDate}T00:00:00+07:00`),
      userId: fund.createdBy, reason: 'Số dư đầu quỹ', counterparty: 'Số dư đầu kỳ' }]
      .concat(sources.map(row => this.settlementEntry(row, fund)).filter(Boolean))
      .concat((fund.vouchers || []).map(row => this.voucherEntry(row)));
    const ids = rows.map(row => row._id);
    if (rows.length) await this.entries.bulkWrite(rows.map(row => ({ replaceOne: { filter: { _id: row._id }, replacement: row, upsert: true } })));
    await this.entries.deleteMany(ids.length ? { _id: { $nin: ids } } : {});
    await this.funds.updateOne({ _id: 'school' }, { $set: { readModelVersion: 2, readModelUpdatedAt: new Date() } });
  }
  async ensureEntries(fund) {
    await this.ensureIndexes();
    if (fund.readModelVersion !== 2) await this.rebuildEntries(fund);
  }
  async syncSettlement(row) {
    const fund = await this.funds.findOne({ _id: 'school' });
    if (!fund || fund.readModelVersion !== 2) return;
    const entry = this.settlementEntry(this.source(row), fund);
    const id = `settlement:${String(row._id)}`;
    if (entry) await this.entries.replaceOne({ _id: id }, entry, { upsert: true });
    else await this.entries.deleteOne({ _id: id });
  }
  async deleteSettlement(row) {
    const fund = await this.funds.findOne({ _id: 'school' });
    if (!fund || fund.readModelVersion !== 2) return;
    const old = (fund.baseline || []).find(item => item.id === String(row._id));
    if (old && old.value) await this.entries.replaceOne({ _id: `settlement:${String(row._id)}` }, {
      _id: `settlement:${String(row._id)}`, code: old.code, type: 'SETTLEMENT', delta: -old.value,
      effectiveAt: new Date(fund.createdAt), createdAt: new Date(fund.createdAt), reason: 'Phiếu thanh toán trước kỳ đã bị xóa — cần đối soát',
      counterparty: 'Đối soát', sourceId: String(row._id)
    }, { upsert: true });
    else await this.entries.deleteOne({ _id: `settlement:${String(row._id)}` });
  }
  async invalidateEntries() {
    await this.funds.updateOne({ _id: 'school' }, { $unset: { readModelVersion: '' } });
  }
  ledger(fund, sources, names = {}) {
    const baseline = new Map(fund.baseline.map(row => [row.id, row]));
    const seen = new Set();
    const entries = [];
    const parentNames = names.parents || new Map();
    const userNames = names.users || new Map();

    const SETTLE_TYPE_LABELS = {
      AUTO_ACB: 'Cấn trừ tự động ACB',
      MANUAL_ACCOUNTANT: 'Kế toán gạch nợ học phí',
      SCHOOL_TRANSFER: 'Trường chuyển cấn trừ ví',
      PARENT_TRANSFER: 'Phụ huynh chuyển cấn trừ',
      WALLET_DEDUCT: 'Trừ số dư ví'
    };

    for (const row of sources) {
      seen.add(row.id);
      const old = baseline.get(row.id);
      const delta = amount((row.status === 'SUCCESS' ? row.amount : 0) - (old ? old.value : 0));
      if (delta) {
        const reason = row.note || (row.settleType ? SETTLE_TYPE_LABELS[row.settleType] : null) || (old ? 'Chênh lệch thanh toán trước kỳ' : 'Thanh toán công nợ');
        const counterparty = row.parentId && parentNames.has(row.parentId) ? `Phụ huynh: ${parentNames.get(row.parentId)}` : 'Thanh toán công nợ';
        const createdByName = row.userId ? (userNames.get(row.userId) || 'Kế toán') : (row.settleType === 'AUTO_ACB' ? 'Hệ thống (ACB Auto)' : 'Hệ thống');
        entries.push({ _id: `settlement:${row.id}`, code: row.code, type: 'SETTLEMENT', delta,
          createdAt: row.at, userId: row.userId, createdByName, reason, counterparty, sourceId: row.id });
      }
    }
    for (const old of baseline.values()) if (!seen.has(old.id) && old.value) entries.push({
      _id: `missing:${old.id}`, code: old.code, type: 'SETTLEMENT', delta: -old.value,
      createdAt: fund.createdAt, reason: 'Phiếu thanh toán trước kỳ đã bị xóa — cần đối soát',
      counterparty: 'Đối soát', createdByName: 'Hệ thống' });

    for (const v of fund.vouchers) {
      entries.push({
        ...v,
        createdByName: v.userId ? (userNames.get(String(v.userId)) || 'Nhân viên') : 'Hệ thống'
      });
    }

    entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a._id).localeCompare(String(b._id)));
    let cash = fund.openingCash;
    const openingCreatedByName = fund.createdBy ? (userNames.get(String(fund.createdBy)) || (String(fund.createdBy).startsWith('opencode:') ? 'Hệ thống (Khởi tạo)' : 'Ban giám hiệu')) : 'Hệ thống';
    const opening = { _id: 'opening', code: 'QD-DAUKY', type: 'OPENING', delta: cash, before: 0, after: cash,
      createdAt: `${fund.startDate}T00:00:00+07:00`, userId: fund.createdBy, createdByName: openingCreatedByName,
      reason: 'Số dư đầu quỹ', counterparty: 'Số dư đầu kỳ' };
    for (const row of entries) { row.before = cash; cash = amount(cash + row.delta); row.after = cash; }
    return { cash, rows: [opening, ...entries].reverse(), revision: fund.revision, startDate: fund.startDate };
  }
  async movement(match = {}) {
    const predicate = Object.keys(match).length ? { $and: [match, { type: { $ne: 'OPENING' } }] } : { type: { $ne: 'OPENING' } };
    const result = await this.entries.aggregate([{ $match: predicate }, { $group: { _id: null,
      income: { $sum: { $cond: [{ $gt: ['$delta', 0] }, '$delta', 0] } },
      expense: { $sum: { $cond: [{ $lt: ['$delta', 0] }, { $abs: '$delta' }, 0] } }, net: { $sum: '$delta' } } }]).toArray();
    return result[0] || { income: 0, expense: 0, net: 0 };
  }
  async summary(page = 1, range = null) {
    const fund = await this.funds.findOne({ _id: 'school' });
    if (!fund) { const e = new Error('Chưa khởi tạo quỹ. Mở Cài đặt quỹ để xác nhận số đầu.'); e.status = 503; throw e; }
    await this.ensureEntries(fund);
    const match = range ? { effectiveAt: { $gte: range.from, $lt: range.toExclusive } } : {};
    const [rows, total, current, period] = await Promise.all([
      this.entries.find(match).sort({ effectiveAt: -1, _id: -1 }).skip((page - 1) * 50).limit(50).toArray(),
      this.entries.countDocuments(match), this.movement(), this.movement(match)
    ]);
    const names = await this.resolveNames({ ...fund, vouchers: rows }, rows);
    const parentNames = names.parents || new Map(), userNames = names.users || new Map();
    let running = fund.openingCash;
    if (rows.length) {
      const first = rows[0];
      const throughFirst = { $or: [{ effectiveAt: { $lt: first.effectiveAt } },
        { effectiveAt: first.effectiveAt, _id: { $lte: first._id } }] };
      running += (await this.movement(throughFirst)).net;
    }
    const decorated = rows.map(row => {
      const after = row.type === 'OPENING' ? fund.openingCash : running;
      if (row.type !== 'OPENING') running = amount(running - row.delta);
      return { ...row, before: row.type === 'OPENING' ? 0 : amount(after - row.delta), after,
      createdByName: row.userId ? (userNames.get(String(row.userId)) || (row.type === 'SETTLEMENT' ? 'Kế toán' : 'Nhân viên')) : 'Hệ thống',
      counterparty: row.counterparty || (row.parentId && parentNames.has(String(row.parentId)) ? `Phụ huynh: ${parentNames.get(String(row.parentId))}` : 'Thanh toán công nợ')
      };
    });
    const cash = amount(fund.openingCash + current.net);
    return { cash, revision: fund.revision, startDate: fund.startDate, page, pageSize: 50, total, rows: decorated,
      periodIncome: period.income, periodExpense: period.expense, periodNet: period.net,
      from: range && range.fromText, to: range && range.toText };
  }
  async post(params, reversal = false) {
    const operationId = required(params.operationId), reason = required(params.reason), userId = required(params.userId);
    const intent = reversal ? { operationId, reason, userId, voucherId: required(params.voucherId) }
      : { operationId, reason, userId, type: params.type, amount: amount(params.amount), counterparty: required(params.counterparty) };
    if (!reversal && (!['WITHDRAWAL', 'DEPOSIT'].includes(intent.type) || intent.amount <= 0)) invalid('Loại phiếu hoặc số tiền không hợp lệ');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
    for (let attempt = 0; attempt < 20; attempt++) {
      const fund = await this.funds.findOne({ _id: 'school' });
      if (!fund) invalid('Cần khởi tạo quỹ trước');
      const previous = fund.vouchers.find(row => row.operationId === operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) invalid('Mã yêu cầu đã dùng với nội dung khác');
        await this.ensureEntries(fund);
        await this.entries.replaceOne({ _id: previous._id }, this.voucherEntry(previous), { upsert: true });
        return previous.response;
      }
      await this.ensureEntries(fund);
      const current = amount(fund.openingCash + (await this.movement()).net);
      let delta;
      if (reversal) {
        const original = fund.vouchers.find(row => row._id === intent.voucherId);
        if (!original || !['WITHDRAWAL', 'DEPOSIT'].includes(original.type)) invalid('Không tìm thấy phiếu rút/nộp');
        if (fund.vouchers.some(row => row.sourceId === original._id && row.type === 'REVERSAL')) invalid('Phiếu đã hoàn tác');
        delta = -original.delta;
      } else delta = intent.type === 'WITHDRAWAL' ? -intent.amount : intent.amount;
      if (!reversal && intent.type === 'WITHDRAWAL' && current + delta < 0) invalid('Số tiền rút vượt quỹ hiện có');
      const id = crypto.randomBytes(12).toString('hex');
      const row = { _id: id, operationId, fingerprint, code: `Q-${String(fund.revision + 1).padStart(7, '0')}`,
        type: reversal ? 'REVERSAL' : intent.type, delta, reason, userId, counterparty: intent.counterparty,
        sourceId: intent.voucherId, createdAt: new Date(), beforeAtPosting: current, afterAtPosting: amount(current + delta) };
      row.response = { id, code: row.code, cash: row.afterAtPosting };
      const result = await this.funds.updateOne({ _id: 'school', revision: fund.revision }, { $push: { vouchers: row }, $inc: { revision: 1 } });
      if (result.modifiedCount === 1 || result.result?.nModified === 1) {
        await this.entries.replaceOne({ _id: row._id }, this.voucherEntry(row), { upsert: true });
        return row.response;
      }
    }
    invalid('Quỹ đang có nhiều thao tác, vui lòng thử lại');
  }
}
module.exports = SchoolFund;
