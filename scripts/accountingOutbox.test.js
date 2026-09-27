// Real, disposable Mongo only. No .env, application startup or external DB URI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { MongoClient } = require('mongodb');
const { AccountingOutboxWorker, paymentEvent } = require('../func/accountingOutbox');
const hub = require('../routes/wsHub');
const docker = (...args) => execFileSync('docker', args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fixture = (id, extra = {}) => ({ _id: id, event: 'PAYMENT_RECEIVED', parentId: 'parent-1',
    createdAt: new Date('2026-01-01T00:00:00Z'), deliveredAt: null,
    response: { cashTransaction: { code: 'CT-TX-1', amount: 60, paymentMethod: 'MONA_PAY',
        bankDescription: 'receipt', createdAt: '2025-12-31T00:00:00Z' },
    settledAmount: 60, remainingDebt: 40, remainingBalance: 0 }, ...extra });

// Exact response shapes returned by AccountingMongo.outflow()/transfer().
const walletFixtures = () => [
    fixture('wallet:refund-1', { event: 'WALLET_REFUNDED', response: {
        success: true, cashTransaction: { id: 'cash-1', code: 'CT-TX-0000000001', amount: 60,
            type: 'OUTFLOW', status: 'ALLOCATED', paymentMethod: 'CASH', bankRef: '',
            bankDescription: 'refund reason', createdAt: '2026-01-01T00:00:00.000Z',
            parent: { id: 'parent-1' } }, newBalance: 0, remainingBalance: 0, remainingDebt: 40
    } }),
    fixture('wallet:transfer-1', { event: 'WALLET_DEBT_SETTLED', response: {
        success: true, settlement: { id: 'settlement-1', code: 'STL-TX-0000000001', amount: 40,
            settleType: 'WALLET_DEDUCT', settledAt: '2026-01-01T00:00:00.000Z' },
        settledAmount: 40, remainingBalance: 20, remainingDebt: 0
    } })
];

test('outbox on disposable real Mongo: atomic claims, crash recovery, retry and fencing',
    { timeout: 120000 }, async t => {
    const name = `sme2-outbox-test-${process.pid}-${Date.now()}`;
    let client;
    docker('run', '-d', '--rm', '--name', name, '--tmpfs', '/data/db', '--tmpfs', '/data/configdb',
        'mongo:7.0', '--bind_ip_all');
    try {
        const ip = docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
        client = await MongoClient.connect(`mongodb://${ip}:27017`,
            { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 30000 });
        const collection = client.db(`accounting_fixture_outbox_${process.pid}`).collection('accounting_outbox_v1');
        let clock = new Date('2026-01-02T00:00:00Z');
        const sent = [];
        const worker = extra => new AccountingOutboxWorker({ collection, now: () => new Date(clock),
            leaseMs: 100, retryMs: 20, maxRetryMs: 40, deliver: async event => sent.push(event), ...extra });
        const reset = async id => { await collection.deleteMany({}); sent.length = 0; await collection.insertOne(fixture(id)); };
        const advance = ms => { clock = new Date(clock.getTime() + ms); };
        await worker().initialize();

        await t.test('one winner across concurrent independent workers; delivered is terminal', async () => {
            await reset('receive:concurrent');
            const results = await Promise.all(Array.from({ length: 12 }, () => worker().runOnce()));
            assert.equal(results.filter(Boolean).length, 1);
            assert.equal(sent.length, 1);
            const row = await collection.findOne({});
            assert.equal(row.state, 'delivered');
            assert.equal(row.attempts, 1);
            assert.ok(row.deliveredAt instanceof Date);
            assert.equal(await worker().runOnce(), false);
        });

        await t.test('process death after claim; expiry permits reclaim and fences stale owner', async () => {
            await reset('receive:crash');
            const old = worker();
            const claim = await old.claim();
            assert.equal(await worker().claim(), null);
            advance(100);
            const next = worker();
            const reclaimed = await next.claim();
            assert.notEqual(claim.leaseToken, reclaimed.leaseToken);
            assert.equal(reclaimed.attempts, 2);
            await old.acknowledge(claim, 'stale');
            await old.retry(claim, new Error('stale'));
            assert.equal((await collection.findOne({})).leaseToken, reclaimed.leaseToken);
            await next.deliver(paymentEvent(reclaimed));
            await next.acknowledge(reclaimed, 'dispatched');
            assert.equal((await collection.findOne({})).state, 'delivered');
        });

        await t.test('crash after send before ack repeats exact identity and committed payload', async () => {
            await reset('allocate:stable');
            const first = worker();
            const claim = await first.claim();
            await first.deliver(paymentEvent(claim)); // simulated process exit: deliberately no ACK
            advance(101);
            await worker().runOnce();
            assert.equal(sent.length, 2);
            assert.deepEqual(sent[0], sent[1]);
            assert.equal(sent[1].eventId, 'allocate:stable');
            assert.equal(sent[1].processedAt, '2026-01-01T00:00:00.000Z');
        });

        await t.test('durable exponential retry is capped; restarts keep event ID', async () => {
            await reset('receive:retry');
            const failing = worker({ deliver: async event => { sent.push(event); throw new Error('transport'); } });
            for (const delay of [20, 40, 40]) {
                await assert.rejects(failing.runOnce(), /transport/);
                const row = await collection.findOne({});
                assert.equal(row.state, 'retry');
                assert.equal(row.nextAttemptAt.getTime() - clock.getTime(), delay);
                assert.equal(row.deliveredAt, null);
                assert.equal(await worker().runOnce(), false);
                advance(delay);
            }
            await worker().runOnce();
            assert.equal(sent.length, 4);
            sent.forEach(event => assert.deepEqual(event, sent[0]));
        });

        await t.test('failed retry write recovers by lease; expired sender cannot acknowledge', async () => {
            await reset('receive:db-failure');
            const broken = worker({ collection: {
                findOneAndUpdate: (...args) => collection.findOneAndUpdate(...args),
                updateOne: async () => { throw new Error('DB unavailable'); }
            }, deliver: async () => { throw new Error('send failed'); } });
            await assert.rejects(broken.runOnce(), /DB unavailable/);
            assert.equal(await worker().runOnce(), false);
            advance(101);
            await worker({ deliver: async event => { sent.push(event); advance(101); } }).runOnce();
            assert.equal((await collection.findOne({})).deliveredAt, null);
            await worker().runOnce();
            assert.equal((await collection.findOne({})).state, 'delivered');
        });

        await t.test('native wallet responses dispatch exactly and replay unchanged after crash and retry', async () => {
            for (const fixtureRow of walletFixtures()) {
                await collection.deleteMany({}); sent.length = 0;
                await collection.insertOne(fixtureRow);
                const first = worker();
                const claim = await first.claim();
                await first.deliver(paymentEvent(claim)); // crash before ACK
                advance(101);
                await assert.rejects(worker({ deliver: async event => {
                    sent.push(event); throw new Error('wallet transport');
                } }).runOnce(), /wallet transport/);
                advance(20);
                // Second claim has attempts=2, so its retry delay is 40ms.
                assert.equal(await worker().runOnce(), false);
                advance(20);
                await worker().runOnce();
                assert.equal(sent.length, 3);
                for (const event of sent) {
                    assert.deepEqual(event, { parentId: 'parent-1', type: fixtureRow.event,
                        eventId: fixtureRow._id, processedAt: fixtureRow.createdAt.toISOString(),
                        data: fixtureRow.response });
                }
                const stored = await collection.findOne({});
                assert.equal(stored.state, 'delivered');
                assert.deepEqual(stored.response, fixtureRow.response);
                assert.equal(await worker().runOnce(), false);
            }
        });

        await t.test('unallocated has no audience; malformed/unknown events stay retryable', async () => {
            await reset('receive:unallocated');
            await collection.updateOne({}, { $set: { parentId: null, event: 'CASH_RECEIVED_UNALLOCATED' } });
            await worker().runOnce();
            assert.equal(sent.length, 0);
            assert.equal((await collection.findOne({})).deliveryOutcome, 'no_parent_audience');
            const [refund, transfer] = walletFixtures();
            for (const invalid of [
                fixture('unknown:parent', { event: 'UNKNOWN' }),
                fixture('unknown:unallocated', { event: 'UNKNOWN', parentId: null }),
                { ...refund, response: { ...refund.response, cashTransaction: undefined } },
                { ...refund, response: { ...refund.response, newBalance: 99 } },
                { ...transfer, response: { ...transfer.response, settlement: undefined } },
                { ...transfer, response: { ...transfer.response, settledAmount: 41 } },
                { ...transfer, parentId: null }
            ]) {
                await collection.deleteMany({}); sent.length = 0;
                await collection.insertOne(invalid);
                for (let attempt = 1; attempt <= 2; attempt++) {
                    await assert.rejects(worker().runOnce(), /Unsupported or malformed/);
                    const stored = await collection.findOne({});
                    assert.equal(stored.state, 'retry');
                    assert.equal(stored.deliveredAt, null);
                    assert.equal(stored.deliveryOutcome, undefined);
                    assert.equal(stored.attempts, attempt);
                    assert.match(stored.lastError, /Unsupported or malformed/);
                    assert.equal(sent.length, 0);
                    advance(40);
                }
            }
        });
    } finally {
        if (client) await client.close();
        docker('stop', name);
    }
});

test('explicit lifecycle: construction idle, idempotent start, stop awaits in-flight delivery', async () => {
    let callback, cancelled, release;
    const worker = new AccountingOutboxWorker({ collection: {}, deliver: async () => {},
        schedule: fn => { callback = fn; return 42; }, cancel: id => { cancelled = id; } });
    assert.equal(callback, undefined);
    worker.start();
    const first = callback;
    worker.start();
    assert.equal(callback, first);
    await worker.stop();
    assert.equal(cancelled, 42);
    worker.runOnce = () => new Promise(resolve => { release = resolve; });
    worker.start(); callback();
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release(); await stopping;
    assert.equal(worker.timer, null);
});

test('hub routes only correct parent, preserves legacy frame, awaits errors and retries offline', async () => {
    const frames = [], other = [];
    const roomId = { toString: () => 'parent-1' };
    hub.parentRooms.set('parent-1', new Set([{ readyState: 1,
        send: (payload, cb) => { frames.push(JSON.parse(payload)); if (cb) cb(); } },
    { readyState: 3, send: () => assert.fail('closed socket') }]));
    hub.parentRooms.set('parent-2', new Set([{ readyState: 1, send: p => other.push(p) }]));
    try {
        assert.equal(hub.sendToParent(roomId, 'PAYMENT_RECEIVED', { amount: 60 }), 1);
        assert.deepEqual(Object.keys(frames[0]).sort(), ['data', 'timestamp', 'type']);
        const event = paymentEvent(fixture('receive:ws'));
        assert.equal(await hub.sendOutboxEvent(event), 1);
        assert.equal(frames[1].eventId, event.eventId);
        assert.equal(frames[1].processedAt, event.processedAt);
        assert.deepEqual(frames[1].data, event.data);
        for (const row of walletFixtures()) {
            await hub.sendOutboxEvent(paymentEvent(row));
            const frame = frames[frames.length - 1];
            assert.equal(frame.type, row.event);
            assert.equal(frame.eventId, row._id);
            assert.equal(frame.processedAt, row.createdAt.toISOString());
            assert.deepEqual(frame.data, row.response);
        }
        assert.equal(other.length, 0);
        hub.parentRooms.set('parent-1', new Set([{ readyState: 1,
            send: (p, cb) => cb(new Error('socket failure')) }]));
        await assert.rejects(hub.sendOutboxEvent(event), /socket failure/);
        hub.parentRooms.delete('parent-1');
        await assert.rejects(hub.sendOutboxEvent(event), /no open sockets/);
    } finally { hub.parentRooms.clear(); }
});
