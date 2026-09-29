// Isolated route tests: no server, database, network or real settlement writes.
// Run: node scripts/parentPortalErrors.test.js
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const routes = {};
let settlementCalls = 0;
const router = {
    use() {},
    post(url, ...handlers) { routes[`POST ${url}`] = handlers; },
    get(url, ...handlers) { routes[`GET ${url}`] = handlers; }
};
const sandbox = {
    module: { exports: {} },
    process: { env: { PARENT_PORTAL_SECRET: 'isolated-test-token' } },
    console: { error() {} },
    require(name) {
        if (name === 'express') return { Router: () => router, json: () => () => {} };
        if (name === 'apollo-server-express') return { gql: (parts, ...values) =>
            parts.reduce((text, part, i) => text + part + (values[i] || ''), '') };
        if (name === '../func/settlement') return {
            async processInflowAndSettle() { settlementCalls++; return { success: true }; }
        };
        throw new Error(`Unexpected dependency: ${name}`);
    }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/parentPortal.js'), 'utf8'), sandbox);

let replies;
let calls;
const context = {
    async executeGraphQL(operation) {
        calls.push(operation);
        assert.ok(replies.length, 'Unexpected GraphQL call');
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
    }
};
sandbox.module.exports({ createContext: () => context });

async function request(url, body, results, token = 'isolated-test-token') {
    replies = results.slice();
    calls = [];
    settlementCalls = 0;
    const req = { body, headers: { 'x-portal-token': token }, query: {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = JSON.parse(JSON.stringify(payload)); return this; } };
    const handlers = routes[`POST ${url}`];
    async function run(index) {
        if (handlers[index]) await handlers[index](req, res, () => run(index + 1));
    }
    await run(0);
    return res;
}

const parent = { id: 'p1', code: 'PH000001', name: 'Parent', debt: 100, balance: 20,
    hocsinhs: [
        { id: 's1', name: 'Student', lophoc: { id: 'c1', name: 'Class',
            chunhiem: [{ id: 't1', name: 'Teacher', phone: '0901' }] } },
        { id: 's2', name: 'Known', status: 'DANG_HOC' },
        { id: 's3', name: 'Empty', status: '' },
        { id: 's4', name: 'Null', status: null }
    ] };
const successful = [
    { data: { allPhones: [{ parent }] } },
    { data: { allNotifications: [] } },
    { data: { allHoaDons: [], allItemKetSos: [] } },
    { data: { 
        allPaymentSettlements: [{ code: 'STL000001', amount: 50,
            settledAt: '2026-09-27', settleType: 'AUTO_ACB', note: 'Settlement' }],
        allPhieuThus: []
    } }
];
let checks = 0;
async function expectStatus(url, body, results, status) {
    const res = await request(url, body, results);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.success, status === 200);
    checks++;
    return res;
}

(async () => {
    const body = { phone: '+84 901-234-567' };
    const ok = await expectStatus('/parent-summary', body, successful, 200);
    assert.equal(calls[0].variables.number, '0901234567');
    assert.deepEqual(Object.keys(ok.body.data),
        ['parent', 'students', 'vietqr', 'latestInvoice', 'invoices', 'notifications', 'paymentHistory']);
    assert.deepEqual(ok.body.data.students[0], {
        id: 's1', name: 'Student', birthday: null, status: null, note: '',
        tuitionDiscount: '0', className: 'Class', classId: 'c1',
        teachers: [{ id: 't1', name: 'Teacher', phone: '0901' }]
    });
    assert.deepEqual(ok.body.data.students.map(s => s.status), [null, 'DANG_HOC', null, null]);
    assert.equal(ok.body.data.paymentHistory[0].code, 'STL000001');
    assert.equal(ok.body.data.paymentHistory[0].method, 'Chuyển khoản ACB');
    assert.equal(ok.body.data.parent.isPaid, false);
    assert.equal(ok.body.data.latestInvoice, null);
    assert.equal(ok.body.data.vietqr.amount, 100);

    for (let index = 0; index < successful.length; index++) {
        for (const failure of [
            { errors: [{ message: 'Database unavailable' }] },
            { ...successful[index], errors: [{ message: 'Partial failure' }] },
            { data: null }, new Error('Rejected query')
        ]) {
            await expectStatus('/parent-summary', body, [...successful.slice(0, index), failure], 500);
            assert.equal(calls.length, index + 1, 'Stop after failed query');
        }
    }
    await expectStatus('/parent-summary', body, [{ data: { allPhones: [] }, errors: [] }], 404);
    await expectStatus('/parent-summary', body, [{ data: { allPhones: [{ parent: null }] } }], 404);
    await expectStatus('/parent-summary', {}, [], 400);
    assert.equal((await request('/parent-summary', body, [], 'wrong')).statusCode, 401);
    assert.equal(calls.length, 0);

    for (const result of [{ errors: [{ message: 'Failed lookup' }] },
        { data: { allParents: [{ id: 'p1' }] }, errors: [{ message: 'Partial' }] },
        { data: { allParents: null } }]) {
        await expectStatus('/acb-webhook', { amount: 50, description: 'PH000001' }, [result], 500);
        assert.equal(settlementCalls, 0, 'Lookup failure must not become an unassigned inflow');
    }
    await expectStatus('/acb-webhook', { amount: 50, description: 'PH000001' },
        [{ data: { allParents: [] } }], 200);
    assert.equal(settlementCalls, 1, 'Genuine unmatched lookup retains compatibility');

    await expectStatus('/config', {}, [{ errors: [{ message: 'Lookup failed' }] }], 500);
    assert.equal(calls.length, 1, 'Failed config lookup must not create settings');
    for (const existing of [[], [{ id: 'config1' }]]) {
        const field = existing.length ? 'updateSystemSetting' : 'createSystemSetting';
        for (const result of [{ errors: [{ message: 'Write failed' }] },
            { data: { [field]: { id: 'config1' } }, errors: [{ message: 'Partial' }] },
            { data: { [field]: null } }, { data: { [field]: { id: 'config1' } } }]) {
            await expectStatus('/config', { portal_enabled: true },
                [{ data: { allSystemSettings: existing } }, result],
                result.errors || result.data[field] === null ? 500 : 200);
        }
    }
    console.log(`parentPortalErrors: ${checks} response cases passed, plus auth and compatibility assertions`);
})().catch(error => { console.error(error); process.exitCode = 1; });
