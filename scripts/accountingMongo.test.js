// Self-contained disposable replica set. Never reads .env or application index.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { Keystone } = require('@keystonejs/keystone');
const { MongooseAdapter } = require('@keystonejs/adapter-mongoose');
const { Text, Relationship } = require('@keystonejs/fields');
const { AccountingMongo, bindContext } = require('../func/accountingMongo');
const Settlement = require('../func/settlement');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('native accounting against disposable Mongo replica set and real Keystone adapters', { timeout: 180000 }, async t => {
    const name = `sme2-accounting-test-${process.pid}-${Date.now()}`;
    let keystone;
    docker('run', '-d', '--rm', '--name', name, '--tmpfs', '/data/db', '--tmpfs', '/data/configdb',
        'mongo:7.0', '--replSet', 'accounting_fixture', '--bind_ip_all', '--setParameter', 'enableTestCommands=1');
    try {
        const ip = docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
        let primary = false;
        for (let i = 0; i < 60; i++) {
            try {
                docker('exec', name, 'mongosh', '--quiet', '--eval',
                    `try { rs.initiate({_id:'accounting_fixture',members:[{_id:0,host:'${ip}:27017'}]}) } catch(e) {} if (!db.hello().isWritablePrimary) quit(2)`);
                primary = true; break;
            } catch (_) { await new Promise(resolve => setTimeout(resolve, 500)); }
        }
        assert.ok(primary, 'fixture replica set elected primary');
        keystone = new Keystone({ name: 'accounting-fixture', cookieSecret: 'fixture-only-secret',
            adapter: new MongooseAdapter({ mongoUri: `mongodb://${ip}:27017/accounting_fixture_${process.pid}?replicaSet=accounting_fixture`,
                useNewUrlParser: true, useUnifiedTopology: true }) });
        // Actual owned list definitions; minimal unrelated relationship targets.
        for (const key of ['Parent', 'CashTransaction', 'PaymentSettlement', 'Log']) {
            keystone.createList(key, require(`../lists/${key}`));
        }
        keystone.createList('Phone', { fields: { parent: { type: Relationship, ref: 'Parent.phone' } } });
        keystone.createList('Student', { fields: { parent: { type: Relationship, ref: 'Parent.hocsinhs' } } });
        for (const key of ['User', 'HoaDon', 'PhieuKetSo']) keystone.createList(key, { fields: { name: { type: Text } } });
        await keystone.connect();
        keystone.createApolloServer({ schemaName: 'public' });
        const repo = await new AccountingMongo(keystone, { isolated: true }).initialize();
        const context = bindContext({ executeGraphQL() { throw new Error('Native core must never use GraphQL writes'); } }, repo);
        await t.test('operational fund opening, live settlement source, CAS vouchers and reversals', async () => {
            const Fund = require('../func/schoolFund');
            const fund = new Fund(keystone);
            const old = new repo.ObjectId(), fresh = new repo.ObjectId();
            const undated = new repo.ObjectId();
            await repo.collections.PaymentSettlement.insertOne({ _id: undated, amount: 25, status: 'SUCCESS' });
            await assert.rejects(fund.initialize({ startDate: '2021-01-01', openingCash: 50 }, 'fixture-admin'), /thiếu ngày/);
            await repo.collections.PaymentSettlement.insertMany([
                { _id: old, code: 'OLD', amount: 300, status: 'SUCCESS', settledAt: new Date('2020-01-01') },
                { _id: fresh, code: 'NEW', amount: 100, status: 'SUCCESS', settledAt: new Date('2021-02-01') }
            ]);
            await fund.initialize({ startDate: '2021-01-01', openingCash: 50, approvedUndatedIds: [String(undated)] }, 'fixture-admin');
            assert.equal((await repo.collections.PaymentSettlement.findOne({ _id: undated })).settledAt, undefined);
            assert.equal((await fund.funds.findOne({ _id: 'school' })).baseline.find(r => r.id === String(undated)).openingClassification, 'UNDATED_INCLUDED_BY_USER_CONFIRMATION');
            assert.equal((await fund.summary()).cash, 150);
            const february = await fund.summary(1, { from: new Date('2021-01-31T17:00:00Z'),
                toExclusive: new Date('2021-02-28T17:00:00Z'), fromText: '2021-02-01', toText: '2021-02-28' });
            assert.deepEqual([february.periodIncome, february.periodExpense, february.periodNet], [100, 0, 100]);
            assert.equal(february.total, 1);
            assert.equal(february.rows[0]._id, `settlement:${fresh}`);
            await fund.initialize({ startDate: '2021-01-01', openingCash: 999 }, 'fixture-admin');
            assert.equal((await fund.summary()).cash, 150);
            const command = { operationId: 'op1', type: 'WITHDRAWAL', amount: 120, reason: 'Rút', counterparty: 'Trường', userId: 'fixture-admin' };
            const results = await Promise.all([fund.post(command), fund.post(command)]);
            assert.deepEqual(results[0], results[1]);
            assert.equal((await fund.summary()).cash, 30);
            await assert.rejects(fund.post({ ...command, operationId: 'op2', amount: 31 }), /vượt quỹ/);
            await fund.post({ operationId: 'undo', voucherId: results[0].id, reason: 'Hủy', userId: 'fixture-admin' }, true);
            assert.equal((await fund.summary()).cash, 150);
            await repo.collections.PaymentSettlement.updateOne({ _id: fresh }, { $set: { status: 'REVERTED' } });
            await fund.syncSettlement(await repo.collections.PaymentSettlement.findOne({ _id: fresh }));
            assert.equal((await fund.summary()).cash, 50);
            await repo.collections.PaymentSettlement.updateOne({ _id: old }, { $set: { status: 'REVERTED' } });
            await fund.syncSettlement(await repo.collections.PaymentSettlement.findOne({ _id: old }));
            assert.equal((await fund.summary()).cash, -250);
            await repo.collections.PaymentSettlement.deleteMany({ _id: { $in: [old, fresh] } });
            await repo.collections.PaymentSettlement.deleteOne({ _id: undated });
            await fund.funds.deleteMany({});
        });
        const parent = async (debt = 100, balance = 0) => {
            const _id = new repo.ObjectId();
            await repo.collections.Parent.insertOne({ _id, code: `PH-${_id}`, debt, balance });
            return String(_id);
        };
        let ref = 0;
        const receipt = (parentId, extra = {}) => ({ parentId, amount: 60, paymentMethod: 'MONA_PAY',
            receivingAccount: '0123456', providerReference: `ref-${++ref}`, bankRef: `bank-${ref}`, ...extra });
        const receive = params => Settlement.processInflowAndSettle(context, params);
        const allocate = params => Settlement.allocateCashTransaction(context, params);
        const refund = params => Settlement.processOutflow(context, params);
        const transfer = params => Settlement.transferBalanceToDebt(context, params);
        let operation = 0;
        const command = (parentId, amount = 30) => ({ operationId: `wallet-test-${++operation}`, parentId, amount });
        const totals = async id => {
            const row = await repo.collections.Parent.findOne({ _id: repo.id(id) });
            return [row.debt, row.balance];
        };
        const counts = async () => Promise.all([...Object.values(repo.collections), repo.operations, repo.outbox, repo.sequences, repo.fundEntries]
            .map(c => c.countDocuments({})));

        await t.test('parallel duplicates, durable response, identity conflict, scoped reference', async () => {
            const id = await parent();
            const params = receipt(id);
            const responses = await Promise.all(Array.from({ length: 8 }, () => receive(params)));
            responses.forEach(r => assert.deepEqual(r, responses[0]));
            assert.deepEqual(await totals(id), [40, 0]);
            assert.equal(await repo.collections.CashTransaction.countDocuments({ providerReference: params.providerReference }), 1);
            await assert.rejects(receive({ ...params, amount: 61 }), /different accounting intent/);
            await assert.rejects(receive({ ...params, parentId: await parent() }), /different accounting intent/);
            await receive({ ...params, receivingAccount: 'other-account', autoSettle: false });
            assert.deepEqual(await totals(id), [40, 60]);
            const stored = await repo.collections.PaymentSettlement.findOne({ parent: repo.id(id) });
            assert.equal(String(stored.cashTransaction), responses[0].cashTransaction.id);
            // Reverse relationship is derived from the settlement FK, not an array on cash.
            const result = await keystone.executeGraphQL({ query: `query { CashTransaction(where:{id:"${responses[0].cashTransaction.id}"}) {
                parent { id } settlements { id parent { id } } } }`, context: keystone.createContext({ skipAccessControl: true }) });
            assert.equal(result.errors, undefined, JSON.stringify(result.errors));
            assert.equal(result.data.CashTransaction.parent.id, id);
            assert.equal(result.data.CashTransaction.settlements.length, 1);
        });

        await t.test('distinct parallel receipts to one parent retry without lost updates', async () => {
            const id = await parent(250, 10);
            await Promise.all(Array.from({ length: 10 }, () => receive(receipt(id, { amount: 30 }))));
            assert.deepEqual(await totals(id), [0, 60]);
            const logs = await repo.collections.Log.find({ idItem: id }).toArray();
            assert.equal(logs.reduce((sum, row) => sum + Number(row.valueChange), 0), 250);
        });

        await t.test('manual fallback and webhook receipt provenance replay the original economic outcome', async () => {
            const id = await parent();
            const fallback = receipt(id, { settleType: 'MANUAL_ACCOUNTANT', note: 'Verified manual recovery' });
            const first = await receive(fallback);
            const before = await counts();
            const webhook = { ...fallback, settleType: 'AUTO_ACB', note: 'Later webhook delivery' };
            assert.deepEqual(await receive(webhook), first);
            assert.deepEqual(await counts(), before);
            assert.deepEqual(await totals(id), [40, 0]);
            const settlement = await repo.collections.PaymentSettlement.findOne({ _id: repo.id(first.settlements[0].id) });
            assert.equal(settlement.settleType, 'MANUAL_ACCOUNTANT');
            assert.equal(settlement.note, 'Verified manual recovery');
            const outcome = await repo.operations.findOne({ 'response.cashTransaction.id': first.cashTransaction.id });
            assert.equal(outcome.intent.settleType, 'MANUAL_ACCOUNTANT');
            assert.deepEqual(outcome.response, first);
            for (const patch of [{ amount: 61 }, { parentId: await parent() }, { autoSettle: false }]) {
                await assert.rejects(receive({ ...webhook, ...patch }), /different accounting intent/);
            }
        });

        await t.test('every receipt write rolls back including counters, relationships and outbox', async () => {
            for (const point of ['sequence:CT', 'cash', 'parent', 'sequence:STL', 'settlement', 'fund-balance', 'sequence:FUND', 'fund-entry', 'log', 'outcome', 'outbox']) {
                const id = await parent();
                const before = await counts();
                const counters = await repo.sequences.find({}).toArray();
                const fundBefore = await repo.schoolFund.findOne({ _id: 'school' });
                repo.afterWrite = async label => { if (label === point) throw new Error(`fault:${point}`); };
                const params = receipt(id);
                await assert.rejects(receive(params), /fault:/);
                repo.afterWrite = async () => {};
                assert.deepEqual(await counts(), before, point);
                assert.deepEqual(await repo.sequences.find({}).toArray(), counters, point);
                assert.deepEqual(await repo.schoolFund.findOne({ _id: 'school' }), fundBefore, point);
                assert.deepEqual(await totals(id), [100, 0]);
                await receive(params);
                assert.deepEqual(await totals(id), [40, 0]);
            }
        });

        await t.test('school cash only increases on settlement; immutable vouchers and reversal preserve parent money', async () => {
            const actor = new repo.ObjectId();
            await repo.collections.User.insertOne({ _id: actor, name: 'Fixture accountant' });
            const userId = String(actor);
            const start = (await repo.schoolFund.findOne({ _id: 'school' })).cash;
            const id = await parent(100, 0);
            const received = receipt(id, { amount: 120, autoSettle: false });
            await receive(received);
            assert.equal((await repo.schoolFund.findOne({ _id: 'school' })).cash, start);
            const pay = command(id, 100);
            await transfer(pay);
            await transfer(pay);
            assert.equal((await repo.schoolFund.findOne({ _id: 'school' })).cash, start + 100);
            await refund(command(id, 20));
            assert.equal((await repo.schoolFund.findOne({ _id: 'school' })).cash, start + 100);
            const request = { operationId: 'fund-withdraw', type: 'WITHDRAWAL', amount: 80,
                userId, reason: 'Bàn giao tiền', counterparty: 'Nhà trường' };
            const results = await Promise.all([repo.fundVoucher(request), repo.fundVoucher(request)]);
            assert.deepEqual(results[0], results[1]);
            assert.equal(results[0].cash, start + 20);
            assert.deepEqual(await totals(id), [0, 0]);
            await assert.rejects(repo.fundVoucher({ ...request, amount: 81 }), /different accounting intent/);
            await assert.rejects(repo.fundVoucher({ ...request, operationId: 'too-large', amount: start + 21 }), /Insufficient/);
            const reversal = { operationId: 'undo-withdraw', voucherId: results[0].id, userId, reason: 'Hủy bàn giao' };
            const undone = await repo.reverseFundVoucher(reversal);
            assert.equal(undone.cash, start + 100);
            assert.deepEqual(await repo.reverseFundVoucher(reversal), undone);
            await assert.rejects(repo.reverseFundVoucher({ ...reversal, operationId: 'undo-twice' }), /already reversed/);
            const before = await repo.schoolFund.findOne({ _id: 'school' });
            const entries = await repo.fundEntries.countDocuments({});
            repo.afterWrite = async label => { if (label === 'fund-entry') throw new Error('fund fault'); };
            const deposit = { ...request, type: 'DEPOSIT', operationId: 'deposit-rollback' };
            await assert.rejects(repo.fundVoucher(deposit), /fund fault/);
            repo.afterWrite = async () => {};
            assert.deepEqual(await repo.schoolFund.findOne({ _id: 'school' }), before);
            assert.equal(await repo.fundEntries.countDocuments({}), entries);
            const posted = await repo.fundVoucher(deposit);
            assert.equal(posted.cash, start + 180);
            const rows = await repo.fundEntries.find({}).sort({ revision: 1 }).toArray();
            assert.equal(rows.reduce((sum, row) => sum + row.delta, 0), posted.cash);
            rows.forEach((row, index) => {
                assert.equal(row.after, row.before + row.delta);
                if (index) assert.equal(row.before, rows[index - 1].after);
            });
        });

        await t.test('lost commit acknowledgement replays persisted outcome from a fresh repository', async () => {
            const id = await parent();
            const params = receipt(id);
            repo.afterCommit = async () => { throw new Error('connection lost after commit'); };
            await assert.rejects(receive(params), /connection lost/);
            repo.afterCommit = async () => {};
            const reopened = await new AccountingMongo(keystone, { isolated: true }).initialize();
            const response = await reopened.receive(params);
            assert.deepEqual(await receive(params), response);
            assert.deepEqual(await totals(id), [40, 0]);
            assert.equal(await repo.outbox.countDocuments({ parentId: id }), 1);
        });

        await t.test('driver retries an actual UnknownTransactionCommitResult from Mongo', async () => {
            const id = await parent();
            await repo.connection.db.admin().command({ configureFailPoint: 'failCommand', mode: { times: 1 },
                data: { failCommands: ['commitTransaction'], errorCode: 91, errorLabels: ['UnknownTransactionCommitResult'] } });
            const params = receipt(id);
            const result = await receive(params);
            assert.deepEqual(await receive(params), result);
            assert.deepEqual(await totals(id), [40, 0]);
        });

        await t.test('allocation same-parent retries and competing reassignment', async () => {
            const original = receipt(null);
            const cash = await receive(original);
            const id = await parent();
            const args = { cashTxId: cash.cashTransaction.id, parentId: id };
            const responses = await Promise.all(Array.from({ length: 6 }, () => allocate(args)));
            responses.forEach(r => assert.deepEqual(r, responses[0]));
            assert.deepEqual(await totals(id), [40, 0]);
            await assert.rejects(allocate({ ...args, parentId: await parent() }), /different accounting intent/);
            assert.deepEqual(await receive(original), cash, 'receipt retry retains original committed snapshot');
            const next = await receive(receipt(null));
            const parents = [await parent(), await parent()];
            const race = await Promise.allSettled(parents.map(parentId => allocate({ cashTxId: next.cashTransaction.id, parentId })));
            assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
            assert.deepEqual((await Promise.all(parents.map(totals))).sort((a, b) => a[0] - b[0]), [[40, 0], [100, 0]]);
        });

        await t.test('allocation failure after every write leaves cash eligible and parent untouched', async () => {
            for (const point of ['allocation-claim', 'parent', 'sequence:STL', 'settlement', 'log', 'outcome', 'outbox']) {
                const cash = await receive(receipt(null));
                const id = await parent();
                const before = await counts();
                repo.afterWrite = async label => { if (label === point) throw new Error('allocation fault'); };
                const args = { cashTxId: cash.cashTransaction.id, parentId: id };
                await assert.rejects(allocate(args), /allocation fault/);
                repo.afterWrite = async () => {};
                assert.deepEqual(await counts(), before);
                assert.deepEqual(await totals(id), [100, 0]);
                const row = await repo.collections.CashTransaction.findOne({ _id: repo.id(args.cashTxId) });
                assert.equal(row.accountingCredited, false);
                assert.equal(row.status, 'UNALLOCATED');
                assert.equal(row.parent, undefined);
                await allocate(args);
            }
        });

        await t.test('legacy, cancelled, outflow, already-credited and missing parent cannot be allocated', async () => {
            const id = await parent();
            for (const patch of [{ accountingVersion: 0 }, { status: 'CANCELLED' }, { type: 'OUTFLOW' }, { accountingCredited: true }]) {
                const cash = await receive(receipt(null));
                await repo.collections.CashTransaction.updateOne({ _id: repo.id(cash.cashTransaction.id) }, { $set: patch });
                await assert.rejects(allocate({ cashTxId: cash.cashTransaction.id, parentId: id }), /review required/);
            }
            const cash = await receive(receipt(null));
            await assert.rejects(allocate({ cashTxId: cash.cashTransaction.id, parentId: String(new repo.ObjectId()) }), /Parent not found/);
            assert.deepEqual(await totals(id), [100, 0]);
            await allocate({ cashTxId: cash.cashTransaction.id, parentId: id, autoSettle: false });
            assert.deepEqual(await totals(id), [100, 60]);
        });

        await t.test('validation, explicit unsupported-path gate and actual unique index', async () => {
            const id = await parent();
            for (const amount of [0, -1, 1.5, '60', 2147483648]) await assert.rejects(receive(receipt(id, { amount })), /integer monetary/);
            await assert.rejects(receive(receipt(id, { receivingAccount: '' })), /receivingAccount/);
            await assert.rejects(receive(receipt(id, { paymentMethod: 'CASH' })), /external receipts only/);
            for (const method of ['processBillCreated']) {
                await assert.rejects(Settlement[method](context, {}), /has not migrated/);
            }
            assert.throws(() => new AccountingMongo(keystone), /gated/);
            const response = await receive(receipt(id));
            const row = await repo.collections.CashTransaction.findOne({ _id: repo.id(response.cashTransaction.id) });
            await assert.rejects(repo.collections.CashTransaction.insertOne({ ...row, _id: new repo.ObjectId(), code: 'UNIQUE-TEST' }), { code: 11000 });
            await repo.adapters.CashTransaction.model.syncIndexes();
            await repo.initialize();
        });
        await t.test('wallet commands require stable IDs, reject changed intent and replay parallel duplicates', async () => {
            for (const run of [refund, transfer]) {
                const id = await parent(100, 100);
                const args = command(id);
                await assert.rejects(run({ ...args, operationId: undefined }), /operationId/);
                const responses = await Promise.all(Array.from({ length: 6 }, () => run(args)));
                responses.forEach(result => assert.deepEqual(result, responses[0]));
                assert.deepEqual(await totals(id), [run === refund ? 100 : 70, 70]);
                for (const patch of [{ amount: 31 }, { parentId: await parent() }]) {
                    await assert.rejects(run({ ...args, ...patch }), /different accounting intent/);
                }
                await assert.rejects((run === refund ? transfer : refund)(args), /different accounting intent/);
                assert.equal(await repo.outbox.countDocuments({ _id: `wallet:${args.operationId}` }), 1);
                const event = await repo.outbox.findOne({ _id: `wallet:${args.operationId}` });
                assert.equal(event.event, run === refund ? 'WALLET_REFUNDED' : 'WALLET_DEBT_SETTLED');
                if (run === refund) {
                    assert.equal(responses[0].cashTransaction.status, 'ALLOCATED');
                    await assert.rejects(allocate({ cashTxId: responses[0].cashTransaction.id, parentId: id }), /review required/);
                    await assert.rejects(run({ ...args, paymentMethod: 'OTHER' }), /different accounting intent/);
                } else {
                    const row = await repo.collections.PaymentSettlement.findOne({ _id: repo.id(responses[0].settlement.id) });
                    assert.equal(row.cashTransaction, undefined);
                    await assert.rejects(run({ ...args, settleType: 'PARENT_TRANSFER' }), /different accounting intent/);
                }
            }
        });

        await t.test('parallel refunds and receipts conserve balance; distinct refunds cannot overdraft', async () => {
            const id = await parent(100, 200);
            const refunds = Array.from({ length: 6 }, () => command(id, 20));
            await Promise.all([...refunds.map(refund), ...Array.from({ length: 6 }, () => receive(receipt(id, {
                amount: 15, autoSettle: false
            })))]);
            assert.deepEqual(await totals(id), [100, 170]);
            assert.equal(await repo.collections.CashTransaction.countDocuments({ parent: repo.id(id), type: 'OUTFLOW' }), 6);
            const tight = await parent(100, 100);
            const race = await Promise.allSettled([refund(command(tight, 80)), refund(command(tight, 80))]);
            assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
            assert.match(race.find(r => r.status === 'rejected').reason.message, /Insufficient/);
            assert.deepEqual(await totals(tight), [100, 20]);
        });

        await t.test('refund and transfer compete for wallet; transfer and receipt preserve debt ledger', async () => {
            const id = await parent(100, 100);
            const race = await Promise.allSettled([refund(command(id, 80)), transfer(command(id, 80))]);
            assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
            const [debt, balance] = await totals(id);
            assert.equal(balance, 20);
            assert.equal(debt, race[0].status === 'fulfilled' ? 100 : 20);
            const next = await parent(300, 100);
            await Promise.all([transfer(command(next, 50)), receive(receipt(next, { amount: 30, autoSettle: false }))]);
            assert.deepEqual(await totals(next), [250, 80]);
            const logs = await repo.collections.Log.find({ idItem: next }).toArray();
            assert.equal(logs.reduce((sum, row) => sum + Number(row.valueChange), 0), 50);
        });

        await t.test('refund and transfer rollback every write including sequences, journals and outcomes', async () => {
            for (const [run, stages] of [[refund, ['parent', 'sequence:CT', 'cash', 'outcome', 'outbox']],
                [transfer, ['parent', 'sequence:STL', 'settlement', 'log', 'outcome', 'outbox']]]) {
                for (const stage of stages) {
                    const id = await parent(100, 100);
                    const args = command(id);
                    const before = await counts();
                    const sequences = await repo.sequences.find({}).toArray();
                    repo.afterWrite = async label => { if (label === stage) throw new Error(`wallet fault:${stage}`); };
                    try { await assert.rejects(run(args), /wallet fault/); }
                    finally { repo.afterWrite = async () => {}; }
                    assert.deepEqual(await counts(), before, stage);
                    assert.deepEqual(await repo.sequences.find({}).toArray(), sequences, stage);
                    assert.deepEqual(await totals(id), [100, 100]);
                    await run(args);
                    assert.deepEqual(await totals(id), [run === refund ? 100 : 70, 70]);
                }
            }
        });

        await t.test('lost wallet commit acknowledgement replays from fresh repository without another debit', async () => {
            for (const [run, method] of [[refund, 'outflow'], [transfer, 'transfer']]) {
                const id = await parent(100, 100);
                const args = command(id);
                repo.afterCommit = async () => { throw new Error('lost wallet acknowledgement'); };
                try { await assert.rejects(run(args), /lost wallet acknowledgement/); }
                finally { repo.afterCommit = async () => {}; }
                const reopened = await new AccountingMongo(keystone, { isolated: true }).initialize();
                assert.deepEqual(await reopened[method](args), await run(args));
                assert.deepEqual(await totals(id), [run === refund ? 100 : 70, 70]);
            }
        });

        await t.test('exact transfer limits, maximum snapshot replay, validation and retry after insufficient funds', async () => {
            const id = await parent(40, 60);
            await assert.rejects(transfer(command(id, 41)), /Insufficient/);
            const args = command(id, null);
            const result = await transfer(args);
            assert.equal(result.settledAmount, 40);
            await receive(receipt(id, { amount: 10, autoSettle: false }));
            assert.deepEqual(await transfer(args), result);
            assert.deepEqual(await totals(id), [0, 30]);
            await assert.rejects(transfer(command(id, null)), /Insufficient/);
            const retry = command(id, 40);
            await assert.rejects(refund(retry), /Insufficient/);
            assert.equal(await repo.operations.findOne({ _id: `wallet:${retry.operationId}` }), null);
            await receive(receipt(id, { amount: 20, autoSettle: false }));
            await refund(retry);
            assert.deepEqual(await totals(id), [0, 10]);
            for (const run of [refund, transfer]) {
                for (const amount of [0, -1, 0.5, '30', 2147483648]) {
                    await assert.rejects(run(command(id, amount)), /integer monetary/);
                }
                await assert.rejects(run(command(String(new repo.ObjectId()))), /Parent not found/);
                await assert.rejects(run({ ...command(id), userId: String(new repo.ObjectId()) }), /User not found/);
            }
        });
    } finally {
        if (keystone) await keystone.disconnect();
        docker('stop', name);
    }
});
