const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gql } = require('apollo-server-express');
const executeAccounting = require('../func/accountingGraphQL');
const SettlementService = require('../func/settlement');

// No Keystone startup, environment loading, network or database. All IDs are fixtures.
const broadcasts = [];
require.cache[require.resolve('../routes/wsHub')] = {
    id: require.resolve('../routes/wsHub'), loaded: true,
    exports: { sendToParent: (...args) => broadcasts.push(args) }
};
const scenarios = [
    ['processInflowAndSettle', { parentId: 'fixture-parent', amount: 50 }],
    ['processInflowAndSettle', { amount: 50 }],
    ['processInflowAndSettle', { parentId: 'fixture-parent', amount: 50, autoSettle: false }],
    ['processOutflow', { parentId: 'fixture-parent', amount: 50 }],
    ['transferBalanceToDebt', { parentId: 'fixture-parent', amount: 50 }],
    ['processBillCreated', { parentId: 'fixture-parent', amount: 50 }],
    ['allocateCashTransaction', { cashTxId: 'fixture-cash', parentId: 'fixture-parent' }],
    ['allocateCashTransaction', { cashTxId: 'fixture-cash', parentId: 'fixture-parent', autoSettle: false }]
];
function fixture(failAt = -1, failure = 'errors') {
    const calls = [];
    return {
        calls,
        async executeGraphQL(options) {
            const field = options.query.definitions[0].selectionSet.selections[0];
            const key = field.name.value;
            calls.push(key);
            const data = { [key]: { id: 'fixture-id', code: 'FIXTURE', balance: 100,
                debt: 200, amount: 50, status: 'UNALLOCATED', type: 'INFLOW' } };
            if (calls.length - 1 === failAt) {
                if (failure === 'throw') throw new Error('transport fixture');
                if (failure === 'null') return { data: { [key]: null } };
                if (failure === 'missing') return { data: {} };
                if (failure === 'no-id') return { data: { [key]: {} } };
                return { data, errors: [{ message: 'private fixture details' }] };
            }
            return { data, errors: [] };
        }
    };
}

for (const [method, params] of scenarios) {
    test(`${method} ${JSON.stringify(params)}: stop at every failed GraphQL step`, async () => {
        const success = fixture();
        const result = await SettlementService[method](success, params);
        if (method !== 'processBillCreated') assert.equal(result.success, true);
        assert.ok(success.calls.length > 1);
        for (let step = 0; step < success.calls.length; step++) {
            for (const mode of ['errors', 'null', 'missing', 'no-id', 'throw']) {
                const context = fixture(step, mode);
                broadcasts.length = 0;
                await assert.rejects(SettlementService[method](context, params), mode === 'throw'
                    ? /transport fixture/ : { code: 'ACCOUNTING_GRAPHQL_FAILED' });
                assert.equal(context.calls.length, step + 1, 'no later GraphQL operation');
                assert.equal(broadcasts.length, 0, 'no payment-success notification');
            }
        }
    });
}

test('debt log failure propagates and error text does not leak GraphQL details', async () => {
    await assert.rejects(SettlementService.writeDebtLog(fixture(0), {
        parentId: 'fixture-parent', change: -50, newDebt: 100
    }), error => error.code === 'ACCOUNTING_GRAPHQL_FAILED' && !error.message.includes('private fixture'));
});

test('checked execution preserves receiver, context, variables and valid result', async () => {
    const context = fixture();
    const options = { context, query: gql`query { Parent(where: {id: "fixture"}) { id } }` };
    const original = context.executeGraphQL;
    context.executeGraphQL = function (actual) {
        assert.equal(this, context);
        assert.equal(actual, options);
        return original.call(this, actual);
    };
    assert.equal((await executeAccounting(context, options)).data.Parent.id, 'fixture-id');
});

test('receipt hook propagates service failure for inflow and refund', async () => {
    const { hooks } = require('../lists/PhieuThu');
    for (const total of [50, -50]) {
        await assert.rejects(hooks.afterChange({ operation: 'create', context: fixture(0),
            updatedItem: { parent: 'fixture-parent', total } }), { code: 'ACCOUNTING_GRAPHQL_FAILED' });
    }
});

test('settlement hook propagates parent read, parent update and journal failure', async () => {
    const { hooks } = require('../lists/PaymentSettlement');
    for (let step = 0; step < 3; step++) {
        const context = fixture(step);
        await assert.rejects(hooks.afterChange({ operation: 'create', context,
            updatedItem: { parent: 'fixture-parent', amount: 50, status: 'SUCCESS' } }),
        { code: 'ACCOUNTING_GRAPHQL_FAILED' });
        assert.equal(context.calls.length, step + 1);
    }
});

test('unallocated status uses an enum literal accepted by the Select field', async () => {
    const context = fixture();
    const original = context.executeGraphQL;
    context.executeGraphQL = function (options) {
        const field = options.query.definitions[0].selectionSet.selections[0];
        if (field.name.value === 'updateCashTransaction') {
            const status = field.arguments.find(arg => arg.name.value === 'data').value.fields[0].value;
            assert.equal(status.kind, 'EnumValue');
            assert.equal(status.value, 'UNALLOCATED');
        }
        return original.call(this, options);
    };
    assert.equal((await SettlementService.processInflowAndSettle(context, { amount: 50 })).success, true);
});
