const crypto = require('crypto');

const contexts = new WeakMap();
const MAX_MONEY = 2147483647; // Keystone GraphQL Int
const INDEX = 'accounting_provider_account_reference';

function fail(message) {
    const error = new Error(message);
    error.code = 'ACCOUNTING_CONFLICT';
    throw error;
}
function money(value, positive = false) {
    if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > MAX_MONEY) {
        fail('Expected a bounded integer monetary amount');
    }
    return value;
}
function text(value, name) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200) {
        fail(`Invalid ${name}`);
    }
    return value;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

// Private persistence fields: not writable through GraphQL. Keep the index in the
// adapter schema because Keystone calls syncIndexes() during connect.
function configureCashSchema(schema) {
    schema.add({ accountingVersion: Number, providerReference: String, receivingAccount: String,
        accountingCredited: Boolean, accountingOperationId: String });
    schema.index({ paymentMethod: 1, receivingAccount: 1, providerReference: 1 }, {
        name: INDEX, unique: true, partialFilterExpression: { accountingVersion: 1 }
    });
}

class AccountingMongo {
    constructor(keystone, { isolated = false, afterWrite = async () => {}, afterCommit = async () => {} } = {}) {
        this.adapters = {};
        this.collections = {};
        for (const key of ['Parent', 'CashTransaction', 'PaymentSettlement', 'Log', 'User']) {
            const adapter = keystone.lists[key].adapter;
            if (!adapter.model) fail('Connect Keystone before constructing accounting repository');
            this.adapters[key] = adapter;
            this.collections[key] = adapter.model.collection;
        }
        this.connection = this.adapters.Parent.model.db;
        // This increment deliberately cannot be enabled on an existing application
        // database. Legacy writers have not yet migrated to this authority.
        if (!isolated || !/^accounting_fixture_[a-zA-Z0-9_]+$/.test(this.connection.name)) {
            fail('Native accounting is gated to explicitly isolated accounting_fixture_* databases');
        }
        for (const adapter of Object.values(this.adapters)) {
            if (adapter.model.db !== this.connection) fail('Accounting models must share one connection');
        }
        this.ObjectId = this.adapters.Parent.mongoose.Types.ObjectId;
        this.fk = {};
        for (const [list, field] of [['CashTransaction', 'parent'], ['CashTransaction', 'createdBy'],
            ['PaymentSettlement', 'parent'], ['PaymentSettlement', 'cashTransaction'], ['PaymentSettlement', 'settledBy']]) {
            const adapter = this.adapters[list];
            const rel = adapter.fieldAdaptersByPath[field].rel;
            if (!rel || rel.tableName !== list || rel.columnName !== field || !adapter.realKeys.includes(field)
                || !['N:1', '1:N'].includes(rel.cardinality)) fail(`Unsupported relationship layout: ${list}.${field}`);
            this.fk[`${list}.${field}`] = rel.columnName;
        }
        // These collections are repository-owned, never adapter-managed.
        this.operations = this.connection.db.collection('accounting_operations_v1');
        this.outbox = this.connection.db.collection('accounting_outbox_v1');
        this.sequences = this.connection.db.collection('accounting_sequences_v1');
        this.schoolFund = this.connection.db.collection('school_fund_v1');
        this.fundEntries = this.connection.db.collection('school_fund_entries_v1');
        this.afterWrite = afterWrite;
        this.afterCommit = afterCommit;
        this.ready = false;
    }

    async initialize() {
        const indexes = await this.collections.CashTransaction.indexes();
        const index = indexes.find(x => x.name === INDEX);
        if (!index || !index.unique || JSON.stringify(index.key) !== JSON.stringify({ paymentMethod: 1,
            receivingAccount: 1, providerReference: 1 }) || index.partialFilterExpression?.accountingVersion !== 1) {
            fail('Required adapter-owned external receipt identity index is absent');
        }
        for (const collection of [this.operations, this.outbox, this.sequences, this.schoolFund, this.fundEntries]) {
            // Explicit initialization outside transactions; only in disposable DBs.
            await collection.createIndex({ _id: 1 });
        }
        await this.fundEntries.createIndex({ sourceKey: 1 }, { unique: true });
        await this.schoolFund.updateOne({ _id: 'school' }, { $setOnInsert: { cash: 0, revision: 0 } }, { upsert: true });
        this.ready = true;
        return this;
    }

    id(value) {
        const str = String(value);
        if (!/^[0-9a-f]{24}$/i.test(str)) fail('Invalid relationship ID');
        return new this.ObjectId(str);
    }
    async write(label, action) {
        const result = await action();
        await this.afterWrite(label);
        return result;
    }
    async code(prefix, session) {
        const result = await this.write(`sequence:${prefix}`, () => this.sequences.findOneAndUpdate(
            { _id: prefix }, { $inc: { value: 1 } }, { upsert: true, returnOriginal: false, session }));
        // Separate namespace from legacy Variable/CT000001/STL000001 counters.
        return `${prefix}-TX-${String(result.value.value).padStart(10, '0')}`;
    }
    outcome(row, fingerprint) {
        if (row.fingerprint !== fingerprint) fail('Operation identity reused with different accounting intent');
        return row.response;
    }
    async transact(key, intent, work) {
        if (!this.ready) fail('Initialize isolated accounting repository first');
        // Receipt delivery provenance may differ between manual recovery and a
        // later webhook. Preserve it in the first committed intent/audit, but do
        // not treat it as a different economic instruction. Transfer settleType
        // remains part of that command's identity contract.
        const fingerprintIntent = { ...intent };
        if (intent.kind === 'receive') delete fingerprintIntent.settleType;
        const fingerprint = hash(fingerprintIntent);
        // withTransaction handles write conflicts and unknown commit results. A
        // concurrent unique-key upsert can instead return E11000: retry with a new
        // snapshot, then read the winning durable outcome and compare its intent.
        for (let attempt = 0; attempt < 8; attempt++) {
            const session = await this.connection.startSession();
            let response;
            try {
                await session.withTransaction(async () => {
                    const existing = await this.operations.findOne({ _id: key }, { session });
                    if (existing) { response = this.outcome(existing, fingerprint); return; }
                    response = await work(session);
                    await this.write('outcome', () => this.operations.insertOne({ _id: key, fingerprint,
                        intent, response, committedAt: new Date() }, { session }));
                    if (!intent.kind.startsWith('fund:')) await this.write('outbox', () => this.outbox.insertOne({ _id: key,
                        event: intent.kind === 'outflow' ? 'WALLET_REFUNDED' : intent.kind === 'transfer'
                            ? 'WALLET_DEBT_SETTLED' : intent.parentId ? 'PAYMENT_RECEIVED' : 'CASH_RECEIVED_UNALLOCATED',
                        parentId: intent.parentId, response, createdAt: new Date(), deliveredAt: null }, { session }));
                }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
                await this.afterCommit(); // Test seam: acknowledgement lost AFTER a real commit.
                return response;
            } catch (error) {
                if (error.code === 11000 && attempt < 7) continue;
                // Do not fabricate success for unknown outcomes. The caller can
                // retry the stable key after a transport/process failure.
                throw error;
            } finally { await session.endSession(); }
        }
    }

    options(params, allocation = false) {
        const autoSettle = params.autoSettle === undefined ? true : params.autoSettle;
        if (typeof autoSettle !== 'boolean') fail('autoSettle must be boolean');
        const parentId = params.parentId ? String(this.id(params.parentId)) : null;
        if (allocation && !parentId) fail('Allocation requires parent');
        const settleType = allocation ? 'MANUAL_ACCOUNTANT' : (params.settleType || 'SCHOOL_TRANSFER');
        if (!['AUTO_ACB', 'SCHOOL_TRANSFER', 'PARENT_TRANSFER', 'MANUAL_ACCOUNTANT', 'WALLET_DEDUCT'].includes(settleType)) {
            fail('Invalid settlement type');
        }
        return { parentId, autoSettle, settleType, userId: params.userId ? String(this.id(params.userId)) : null };
    }
    async checkUser(userId, session) {
        if (userId && !await this.collections.User.findOne({ _id: this.id(userId) }, { session })) fail('User not found');
    }
    async credit(cash, options, params, session) {
        if (!options.parentId) return { settledAmount: 0, remainingBalance: 0, remainingDebt: 0, settlements: [] };
        const parent = await this.collections.Parent.findOne({ _id: this.id(options.parentId) }, { session });
        if (!parent) fail('Parent not found');
        const balance = money(money(parent.balance ?? 0) + money(cash.amount, true));
        const debt = money(parent.debt ?? 0);
        const settledAmount = options.autoSettle ? Math.min(balance, debt) : 0;
        const remainingBalance = balance - settledAmount;
        const remainingDebt = debt - settledAmount;
        // Snapshot read + write of the same parent causes competing transactions
        // to retry. No lost update between distinct receipts to the same wallet.
        await this.write('parent', () => this.collections.Parent.updateOne({ _id: parent._id }, {
            $set: { balance: remainingBalance, debt: remainingDebt }
        }, { session }));
        const settlements = [];
        if (settledAmount) {
            const settlement = { _id: new this.ObjectId(), code: await this.code('STL', session),
                [this.fk['PaymentSettlement.parent']]: parent._id,
                [this.fk['PaymentSettlement.cashTransaction']]: cash._id,
                amount: settledAmount, settleType: options.settleType, status: 'SUCCESS',
                note: params.note || '', settledAt: new Date() };
            if (options.userId) settlement[this.fk['PaymentSettlement.settledBy']] = this.id(options.userId);
            await this.write('settlement', () => this.collections.PaymentSettlement.insertOne(settlement, { session }));
            await this.postFund({ type: 'SETTLEMENT', delta: settledAmount, sourceKey: `settlement:${settlement._id}`,
                sourceId: String(settlement._id), parentId: options.parentId, userId: options.userId,
                reason: 'Thanh toán công nợ' }, session);
            await this.write('log', () => this.collections.Log.insertOne({ _id: new this.ObjectId(), item: 'Parent',
                idItem: options.parentId, key: 'debt', value: String(remainingDebt), type: 'DOWN',
                valueChange: String(settledAmount), itemS: 'PaymentSettlement', idItemS: String(settlement._id),
                createdAt: new Date().toISOString(), createdTime: Math.floor(Date.now() / 1000) }, { session }));
            settlements.push({ id: String(settlement._id), code: settlement.code, amount: settledAmount,
                settledAt: settlement.settledAt.toISOString() });
        }
        return { settledAmount, remainingBalance, remainingDebt, settlements };
    }
    cashResponse(cash) {
        return { id: String(cash._id), code: cash.code, amount: cash.amount, type: cash.type,
            status: cash.status, paymentMethod: cash.paymentMethod, bankRef: cash.bankRef,
            bankDescription: cash.bankDescription, createdAt: cash.createdAt.toISOString(),
            parent: cash.parent ? { id: String(cash.parent) } : null };
    }
    async walletParent(parentId, session) {
        if (!parentId) fail('Wallet operation requires parent');
        const parent = await this.collections.Parent.findOne({ _id: this.id(parentId) }, { session });
        if (!parent) fail('Parent not found');
        return { ...parent, balance: money(parent.balance ?? 0), debt: money(parent.debt ?? 0) };
    }
    async outflow(params) {
        // Caller persists this ID before submitting; never derive it from time,
        // amount, a HTTP attempt or a newly generated ID on every retry.
        const operationId = text(params.operationId, 'operationId');
        const parentId = String(this.id(params.parentId));
        const amount = money(params.amount, true);
        const paymentMethod = params.paymentMethod || 'CASH';
        if (!['CASH', 'ACB_BANK', 'MONA_PAY', 'OTHER'].includes(paymentMethod)) fail('Invalid payment method');
        const userId = params.userId ? String(this.id(params.userId)) : null;
        const intent = { kind: 'outflow', operationId, parentId, amount, paymentMethod };
        // Shared command namespace prevents reusing one ID for a different kind.
        return this.transact(`wallet:${operationId}`, intent, async session => {
            await this.checkUser(userId, session);
            const parent = await this.walletParent(parentId, session);
            if (parent.balance < amount) fail('Insufficient wallet balance');
            const newBalance = parent.balance - amount;
            await this.write('parent', () => this.collections.Parent.updateOne({ _id: parent._id }, {
                $set: { balance: newBalance }
            }, { session }));
            const cash = { _id: new this.ObjectId(), code: await this.code('CT', session),
                type: 'OUTFLOW', amount, paymentMethod, bankRef: '', bankDescription: params.reason || '',
                [this.fk['CashTransaction.parent']]: parent._id, createdAt: new Date(),
                // ALLOCATED means posted to a parent's wallet, not bank payout
                // confirmation. Version 2 is wallet outflow, never external receipt
                // identity version 1 (which requires provider/account/reference).
                status: 'ALLOCATED', accountingVersion: 2, accountingOperationId: operationId };
            if (userId) cash[this.fk['CashTransaction.createdBy']] = this.id(userId);
            await this.write('cash', () => this.collections.CashTransaction.insertOne(cash, { session }));
            return { success: true, cashTransaction: this.cashResponse(cash), newBalance,
                remainingBalance: newBalance, remainingDebt: parent.debt };
        });
    }
    async transfer(params) {
        const operationId = text(params.operationId, 'operationId');
        const options = this.options(params);
        if (!options.parentId) fail('Wallet operation requires parent');
        // null/omitted means maximum at FIRST commit. Replays return that snapshot
        // even if the wallet/debt subsequently changes. Explicit amounts are exact,
        // never silently reduced to the available balance or outstanding debt.
        const amount = params.amount == null ? null : money(params.amount, true);
        const intent = { kind: 'transfer', operationId, parentId: options.parentId,
            amount, settleType: options.settleType };
        return this.transact(`wallet:${operationId}`, intent, async session => {
            await this.checkUser(options.userId, session);
            const parent = await this.walletParent(options.parentId, session);
            const settledAmount = amount === null ? Math.min(parent.balance, parent.debt) : amount;
            if (!settledAmount || settledAmount > parent.balance || settledAmount > parent.debt) {
                fail('Insufficient wallet balance or outstanding debt');
            }
            const remainingBalance = parent.balance - settledAmount;
            const remainingDebt = parent.debt - settledAmount;
            await this.write('parent', () => this.collections.Parent.updateOne({ _id: parent._id }, {
                $set: { balance: remainingBalance, debt: remainingDebt }
            }, { session }));
            const settlement = { _id: new this.ObjectId(), code: await this.code('STL', session),
                [this.fk['PaymentSettlement.parent']]: parent._id, amount: settledAmount,
                settleType: options.settleType, status: 'SUCCESS', note: params.note || '', settledAt: new Date() };
            if (options.userId) settlement[this.fk['PaymentSettlement.settledBy']] = this.id(options.userId);
            // An internal wallet transfer has no new external cash movement/FK.
            await this.write('settlement', () => this.collections.PaymentSettlement.insertOne(settlement, { session }));
            await this.postFund({ type: 'SETTLEMENT', delta: settledAmount, sourceKey: `settlement:${settlement._id}`,
                sourceId: String(settlement._id), parentId: options.parentId, userId: options.userId,
                reason: 'Cấn trừ ví trả công nợ' }, session);
            await this.write('log', () => this.collections.Log.insertOne({ _id: new this.ObjectId(), item: 'Parent',
                idItem: options.parentId, key: 'debt', value: String(remainingDebt), type: 'DOWN',
                valueChange: String(settledAmount), itemS: 'PaymentSettlement', idItemS: String(settlement._id),
                createdAt: new Date().toISOString(), createdTime: Math.floor(Date.now() / 1000) }, { session }));
            return { success: true, settlement: { id: String(settlement._id), code: settlement.code,
                amount: settledAmount, settleType: settlement.settleType, settledAt: settlement.settledAt.toISOString() },
                settledAmount, remainingBalance, remainingDebt };
        });
    }
    async postFund(entry, session) {
        const before = await this.schoolFund.findOne({ _id: 'school' }, { session });
        if (!before) fail('School fund opening balance is missing');
        const cash = before.cash + entry.delta;
        if (!Number.isSafeInteger(cash) || Math.abs(cash) > MAX_MONEY) fail('School fund amount out of range');
        await this.write('fund-balance', () => this.schoolFund.updateOne({ _id: 'school' },
            { $set: { cash }, $inc: { revision: 1 } }, { session }));
        const row = { _id: new this.ObjectId(), code: await this.code('FUND', session), ...entry,
            status: 'POSTED', before: before.cash, after: cash, revision: before.revision + 1, createdAt: new Date() };
        await this.write('fund-entry', () => this.fundEntries.insertOne(row, { session }));
        return { id: String(row._id), code: row.code, type: row.type, amount: Math.abs(row.delta), cash,
            revision: row.revision, createdAt: row.createdAt.toISOString() };
    }

    // Posted vouchers are immutable. Correction uses a linked reversal voucher.
    async fundVoucher(params) {
        const operationId = text(params.operationId, 'operationId');
        const type = params.type;
        if (!['WITHDRAWAL', 'DEPOSIT'].includes(type)) fail('Invalid fund voucher type');
        const amount = money(params.amount, true);
        const userId = String(this.id(params.userId));
        const reason = text(params.reason, 'reason');
        const counterparty = text(params.counterparty, 'counterparty');
        const intent = { kind: 'fund:voucher', operationId, type, amount, userId, reason, counterparty };
        return this.transact(`fund:${operationId}`, intent, async session => {
            await this.checkUser(userId, session);
            const fund = await this.schoolFund.findOne({ _id: 'school' }, { session });
            if (type === 'WITHDRAWAL' && (!fund || fund.cash < amount)) fail('Insufficient school fund');
            return this.postFund({ type, delta: type === 'WITHDRAWAL' ? -amount : amount,
                sourceKey: `voucher:${operationId}`, userId, reason, counterparty }, session);
        });
    }

    async reverseFundVoucher(params) {
        const operationId = text(params.operationId, 'operationId');
        const voucherId = String(this.id(params.voucherId));
        const userId = String(this.id(params.userId));
        const reason = text(params.reason, 'reason');
        return this.transact(`fund:${operationId}`, { kind: 'fund:reverse', operationId, voucherId, userId, reason }, async session => {
            await this.checkUser(userId, session);
            const original = await this.fundEntries.findOne({ _id: this.id(voucherId) }, { session });
            if (!original || !['WITHDRAWAL', 'DEPOSIT'].includes(original.type)) fail('Only manual vouchers may be reversed here');
            if (await this.fundEntries.findOne({ sourceKey: `reversal:${voucherId}` }, { session })) fail('Voucher already reversed');
            return this.postFund({ type: 'REVERSAL', delta: -original.delta,
                sourceKey: `reversal:${voucherId}`, sourceId: voucherId, userId, reason }, session);
        });
    }

    async receive(params) {
        if (!['ACB_BANK', 'MONA_PAY'].includes(params.paymentMethod)) fail('Opt-in repository supports external receipts only');
        const options = this.options(params);
        const identity = { paymentMethod: params.paymentMethod,
            receivingAccount: text(params.receivingAccount, 'receivingAccount'),
            providerReference: text(params.providerReference, 'providerReference') };
        const intent = { kind: 'receive', ...identity, amount: money(params.amount, true),
            parentId: options.parentId, autoSettle: options.autoSettle, settleType: options.settleType };
        return this.transact(`receive:${hash(identity)}`, intent, async session => {
            await this.checkUser(options.userId, session);
            const cash = { _id: new this.ObjectId(), ...identity, accountingVersion: 1,
                accountingCredited: !!options.parentId, type: 'INFLOW', amount: intent.amount,
                code: await this.code('CT', session), bankRef: params.bankRef || '',
                bankDescription: params.note || params.bankDescription || '', createdAt: new Date(),
                status: options.parentId ? 'ALLOCATED' : 'UNALLOCATED' };
            if (options.parentId) cash[this.fk['CashTransaction.parent']] = this.id(options.parentId);
            if (options.userId) cash[this.fk['CashTransaction.createdBy']] = this.id(options.userId);
            await this.write('cash', () => this.collections.CashTransaction.insertOne(cash, { session }));
            const result = await this.credit(cash, options, params, session);
            return { success: true, cashTransaction: this.cashResponse(cash), ...result };
        });
    }
    async allocate(params) {
        const options = this.options(params, true);
        const cashId = this.id(params.cashTxId);
        const intent = { kind: 'allocate', cashTxId: String(cashId), parentId: options.parentId,
            autoSettle: options.autoSettle, settleType: options.settleType };
        return this.transact(`allocate:${cashId}`, intent, async session => {
            await this.checkUser(options.userId, session);
            const claimed = await this.write('allocation-claim', () => this.collections.CashTransaction.findOneAndUpdate({
                _id: cashId, accountingVersion: 1, accountingCredited: false,
                type: 'INFLOW', status: 'UNALLOCATED', [this.fk['CashTransaction.parent']]: null
            }, { $set: { accountingCredited: true, status: 'ALLOCATED',
                [this.fk['CashTransaction.parent']]: this.id(options.parentId) } }, { session, returnOriginal: false }));
            const cash = claimed.value;
            if (!cash) fail('Cash is legacy, missing, cancelled, outflow or already credited; review required');
            const result = await this.credit(cash, options, params, session);
            return { success: true, cashTransactionId: String(cashId), parentId: options.parentId,
                cashTransaction: this.cashResponse(cash), ...result };
        });
    }
}

module.exports = {
    AccountingMongo, configureCashSchema,
    bindContext(context, repository) {
        if (!(repository instanceof AccountingMongo) || !repository.ready) fail('Expected initialized isolated repository');
        contexts.set(context, repository);
        return context;
    },
    repositoryFor: context => contexts.get(context),
    rejectUnsupported(context) {
        if (contexts.has(context)) fail('This financial operation has not migrated to the opt-in repository');
    }
};
