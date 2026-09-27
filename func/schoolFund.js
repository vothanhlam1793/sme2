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
  }
  async sources() {
    const rows = await this.settlements.find({}).toArray();
    return rows.map(row => ({ id: String(row._id), code: row.code, amount: amount(row.amount || 0),
      status: row.status, at: row.settledAt, userId: row.settledBy ? String(row.settledBy) : null }));
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
    return this.funds.findOne({ _id: 'school' });
  }
  ledger(fund, sources) {
    const baseline = new Map(fund.baseline.map(row => [row.id, row]));
    const seen = new Set();
    const entries = [];
    for (const row of sources) {
      seen.add(row.id);
      const old = baseline.get(row.id);
      const delta = amount((row.status === 'SUCCESS' ? row.amount : 0) - (old ? old.value : 0));
      if (delta) entries.push({ _id: `settlement:${row.id}`, code: row.code, type: 'SETTLEMENT', delta,
        createdAt: row.at, userId: row.userId, reason: old ? 'Chênh lệch thanh toán trước kỳ' : 'Thanh toán công nợ', sourceId: row.id });
    }
    for (const old of baseline.values()) if (!seen.has(old.id) && old.value) entries.push({
      _id: `missing:${old.id}`, code: old.code, type: 'SETTLEMENT', delta: -old.value,
      createdAt: fund.createdAt, reason: 'Phiếu thanh toán trước kỳ đã bị xóa — cần đối soát' });
    entries.push(...fund.vouchers);
    entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a._id).localeCompare(String(b._id)));
    let cash = fund.openingCash;
    const opening = { _id: 'opening', code: 'QD-DAUKY', type: 'OPENING', delta: cash, before: 0, after: cash,
      createdAt: `${fund.startDate}T00:00:00+07:00`, userId: fund.createdBy, reason: 'Số dư đầu quỹ' };
    for (const row of entries) { row.before = cash; cash = amount(cash + row.delta); row.after = cash; }
    return { cash, rows: [opening, ...entries].reverse(), revision: fund.revision, startDate: fund.startDate };
  }
  async summary(page = 1) {
    const fund = await this.funds.findOne({ _id: 'school' });
    if (!fund) { const e = new Error('Chưa khởi tạo quỹ. Mở Cài đặt quỹ để xác nhận số đầu.'); e.status = 503; throw e; }
    const result = this.ledger(fund, await this.sources());
    return { ...result, total: result.rows.length, page, pageSize: 50, rows: result.rows.slice((page - 1) * 50, page * 50) };
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
      if (previous) { if (previous.fingerprint !== fingerprint) invalid('Mã yêu cầu đã dùng với nội dung khác'); return previous.response; }
      const current = this.ledger(fund, await this.sources()).cash;
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
      if (result.modifiedCount === 1 || result.result?.nModified === 1) return row.response;
    }
    invalid('Quỹ đang có nhiều thao tác, vui lòng thử lại');
  }
}
module.exports = SchoolFund;
