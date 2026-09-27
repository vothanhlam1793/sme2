const crypto = require('crypto');

// Notification-only consumer of accountingMongo's committed outbox. Never calls
// settlement/receive/allocate. Import and construction perform no I/O or startup.
// Mongo driver 3.x returns { value }; newer drivers may return the document.
function document(result) {
    return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
}
function paymentEvent(row) {
    const response = row.response;
    const cash = response?.cashTransaction;
    const amount = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
    const walletBalances = response?.success === true && amount(response.remainingBalance)
        && amount(response.remainingDebt);
    let data;
    if (row.event === 'PAYMENT_RECEIVED' && cash) {
        // Preserve the existing parent payment payload rather than exposing the
        // repository response as a breaking change for this established event.
        data = {
            transactionCode: cash.code, amount: cash.amount, paymentMethod: cash.paymentMethod,
            description: cash.bankDescription || '', settledAmount: response.settledAmount,
            remainingDebt: response.remainingDebt, remainingBalance: response.remainingBalance,
            receivedAt: new Date(row.createdAt).toISOString()
        };
    } else if (row.event === 'WALLET_REFUNDED' && walletBalances && cash?.type === 'OUTFLOW'
        && cash.id && cash.code && amount(cash.amount) && cash.amount > 0
        && response.newBalance === response.remainingBalance) {
        // Native outflow response has no settledAmount or settlements. Forward
        // its exact committed shape, including newBalance and cashTransaction.
        data = response;
    } else if (row.event === 'WALLET_DEBT_SETTLED' && walletBalances && !cash
        && response.settlement?.id && response.settlement.code
        && amount(response.settledAmount) && response.settledAmount > 0
        && response.settlement.amount === response.settledAmount) {
        // Native transfer has one settlement and no new external cash movement.
        data = response;
    }
    if (!data || !row.parentId || row._id == null || row.createdAt == null) {
        throw new Error('Unsupported or malformed parent outbox event');
    }
    const processedAt = new Date(row.createdAt).toISOString();
    return {
        parentId: String(row.parentId), type: row.event, eventId: String(row._id), processedAt,
        data
    };
}

class AccountingOutboxWorker {
    constructor({ collection, deliver, now = () => new Date(),
        token = () => crypto.randomBytes(24).toString('hex'), leaseMs = 30000,
        retryMs = 1000, maxRetryMs = 300000, pollMs = 1000,
        onError = () => {}, schedule = setTimeout, cancel = clearTimeout } = {}) {
        if (!collection || typeof deliver !== 'function') throw new Error('Inject outbox collection and deliver');
        for (const value of [leaseMs, retryMs, maxRetryMs, pollMs]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Worker durations must be positive integers');
        }
        Object.assign(this, { collection, deliver, now, token, leaseMs, retryMs, maxRetryMs,
            pollMs, onError, schedule, cancel });
        this.running = false;
        this.timer = null;
        this.active = null;
    }

    // Explicit schema setup; callers decide when/where index creation is allowed.
    async initialize() {
        await this.collection.createIndex({ deliveredAt: 1, nextAttemptAt: 1, leaseUntil: 1, createdAt: 1 },
            { name: 'accounting_outbox_dispatch' });
        return this;
    }

    async claim() {
        const now = this.now();
        const result = await this.collection.findOneAndUpdate({
            deliveredAt: null,
            $and: [
                { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
                { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }
            ]
        }, {
            $set: { state: 'processing', leaseToken: this.token(), claimedAt: now,
                leaseUntil: new Date(now.getTime() + this.leaseMs) },
            $inc: { attempts: 1 }
        }, { sort: { createdAt: 1, _id: 1 }, returnDocument: 'after',
            writeConcern: { w: 'majority' } });
        return document(result);
    }

    fence(row) {
        return { _id: row._id, deliveredAt: null, leaseToken: row.leaseToken,
            leaseUntil: { $gt: this.now() } };
    }

    async acknowledge(row, outcome) {
        return this.collection.updateOne(this.fence(row), {
            $set: { state: 'delivered', deliveredAt: this.now(), deliveryOutcome: outcome },
            $unset: { leaseToken: '', leaseUntil: '', nextAttemptAt: '', lastError: '' }
        }, { writeConcern: { w: 'majority' } });
    }

    async retry(row, error) {
        const delay = Math.min(this.maxRetryMs, this.retryMs * Math.pow(2, Math.min(row.attempts - 1, 30)));
        return this.collection.updateOne(this.fence(row), {
            $set: { state: 'retry', nextAttemptAt: new Date(this.now().getTime() + delay),
                lastFailedAt: this.now(), lastError: String(error.message || error).slice(0, 1000) },
            $unset: { leaseToken: '', leaseUntil: '' }
        }, { writeConcern: { w: 'majority' } });
    }

    async runOnce() {
        const row = await this.claim();
        if (!row) return false;
        try {
            if (row.event === 'CASH_RECEIVED_UNALLOCATED' && !row.parentId) {
                // No parent audience. A later allocation has its own outbox ID.
                await this.acknowledge(row, 'no_parent_audience');
            } else {
                await this.deliver(paymentEvent(row));
                await this.acknowledge(row, 'dispatched');
            }
        } catch (error) {
            // Failed retry persistence leaves the claim recoverable by lease expiry.
            await this.retry(row, error);
            throw error;
        }
        return true;
    }

    start() {
        if (this.running) return this;
        this.running = true;
        const tick = () => {
            this.timer = null;
            if (!this.running) return;
            this.active = this.runOnce().catch(error => this.onError(error)).catch(() => {}).finally(() => {
                this.active = null;
                if (this.running) this.timer = this.schedule(tick, this.pollMs);
            });
        };
        this.timer = this.schedule(tick, 0);
        return this;
    }

    async stop() {
        this.running = false;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        if (this.active) await this.active;
    }
}

// Explicit opt-in wiring example (NOT installed in application startup):
// new AccountingOutboxWorker({ collection: repo.outbox,
//   deliver: event => wsHub.sendOutboxEvent(event), onError: report }).start();
// Dispatch is at-least-once, not client-ACK delivery. A crash after sending can
// repeat the same eventId. Clients deduplicate and refresh authoritative summary;
// they must not apply financial operations or assume snapshot ordering.
module.exports = { AccountingOutboxWorker, paymentEvent };
