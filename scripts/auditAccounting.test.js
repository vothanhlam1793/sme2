const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerIdentity } = require('../func/accountingIdentity');
const { audit } = require('./auditAccounting');

const payment = { parentId: 'p', amount: 100, paymentMethod: 'MONA_PAY', receivingAccount: '001', providerReference: 'r', bankRef: 'bank-r' };
test('provider identity distinguishes provider/account/reference without losing bankRef', () => {
    const original = { ...payment };
    const key = providerIdentity(payment);
    for (const change of [{ paymentMethod: 'ACB_BANK' }, { receivingAccount: '01' }, { providerReference: 'r2' }]) assert.notEqual(providerIdentity({ ...payment, ...change }), key);
    assert.deepEqual(payment, original);
    assert.throws(() => providerIdentity({ ...payment, receivingAccount: 1 }));
    assert.throws(() => providerIdentity({ ...payment, providerReference: '' }));
    assert.equal(providerIdentity({ ...payment, bankRef: 'display-ref' }), key);
});

const snapshot = () => ({ parents: [{ id: 'p', debt: 50, balance: 20 }], cashTransactions: [], settlements: [], logs: [] });
test('empty exports and orphan evidence cannot produce a clean audit', () => {
    assert.equal(audit({ parents: [], cashTransactions: [], settlements: [], logs: [] }).status, 'REVIEW_REQUIRED');
    const data = snapshot();
    data.events = [{ id: 'orphan', parentId: 'missing', debtDelta: 1, walletDelta: 0 }];
    assert.ok(audit(data).issues.some(i => i.kind === 'ORPHAN_OR_DUPLICATE_EVENT'));
});
test('legacy debt logs do not manufacture a wallet or debt pass', () => {
    const data = snapshot();
    data.logs.push({ item: 'Parent', idItem: 'p', key: 'debt', value: '50' });
    const report = audit(data);
    assert.equal(report.parents[0].debt, 'UNKNOWN');
    assert.equal(report.parents[0].wallet, 'UNKNOWN');
    assert.equal(report.status, 'REVIEW_REQUIRED');
});

test('audit independently detects debt AND wallet drift against supplied opening/events', () => {
    const data = snapshot();
    data.openings = [{ parentId: 'p', debt: 100, wallet: 0, evidence: 'reviewed opening' }];
    data.coverage = { p: 'REVIEWED_COMPLETE' };
    data.events = [{ id: 'e', parentId: 'p', debtDelta: -50, walletDelta: 30, evidence: 'receipt and settlement' }];
    let report = audit(data);
    assert.equal(report.parents[0].debt, 'MATCH');
    assert.equal(report.parents[0].wallet, 'MISMATCH');
    data.parents[0].debt = 49;
    data.parents[0].balance = 30;
    report = audit(data);
    assert.equal(report.parents[0].debt, 'MISMATCH');
    assert.equal(report.parents[0].wallet, 'MATCH');
    data.events.push(data.events[0]);
    assert.equal(audit(data).parents[0].wallet, 'UNKNOWN');
});

test('audit flags duplicate provider identity, missing identity and invalid allocation link', () => {
    const data = snapshot();
    data.cashTransactions = [{ ...payment, id: 'a', parent: 'p', type: 'INFLOW', status: 'ALLOCATED' }, { ...payment, id: 'b' }, { ...payment, id: 'c', receivingAccount: '' }];
    data.settlements = [{ id: 's', parent: 'p', cashTransaction: 'missing', amount: 50, status: 'SUCCESS' }];
    const kinds = audit(data).issues.map(i => i.kind);
    for (const kind of ['DUPLICATE_PROVIDER_IDENTITY', 'MISSING_PROVIDER_IDENTITY', 'INVALID_SETTLEMENT_CASH_LINK']) assert.ok(kinds.includes(kind));
});
