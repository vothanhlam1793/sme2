# Transactional outbox implementation

Updated: 2026-09-27. Scope: `sme2` notification consumer; no production startup binding.

## Artifacts

- `func/accountingOutbox.js`: injectable Mongo consumer and event mapper (`paymentEvent`, retained export name for compatibility).
- `routes/wsHub.js`: parent-room delivery with async socket send callbacks and additive outbox metadata.
- `scripts/accountingOutbox.test.js`: disposable real-Mongo claim/state tests, explicit lifecycle tests, mocked-socket routing/envelope tests.

## Native contract and event mapping

Source inspected: `func/accountingMongo.js`, including `transact`, `outflow`, `transfer`, `receive`, and `allocate`. Outbox rows contain `_id`, `event`, `parentId`, `response`, `createdAt`, and initially null `deliveredAt`.

Every parent event uses the row's `parentId`, exact event name, `eventId = String(_id)`, and `processedAt = createdAt` serialized as ISO 8601. These are stable across claims/retries. The hub's `timestamp` is the current send time, not the original processing time.

| Native event | WebSocket `data` contract |
| --- | --- |
| `PAYMENT_RECEIVED` | Existing compatible projection: `transactionCode`, `amount`, `paymentMethod`, `description`, `settledAmount`, `remainingDebt`, `remainingBalance`, `receivedAt`. `receivedAt` is the outbox creation time, including for allocation of previously received cash. |
| `WALLET_REFUNDED` | Exact committed native response: `success`, nested `cashTransaction`, `newBalance`, `remainingBalance`, `remainingDebt`. No fabricated settlement fields. Requires an OUTFLOW cash transaction with positive bounded amount and matching `newBalance`/`remainingBalance`. |
| `WALLET_DEBT_SETTLED` | Exact committed native response: `success`, singular nested `settlement` (`id`, `code`, `amount`, `settleType`, `settledAt`), `settledAmount`, `remainingBalance`, `remainingDebt`. No fabricated cash movement, transaction code, or payment method. Settlement amount must match the positive bounded settled amount. |
| `CASH_RECEIVED_UNALLOCATED` with no parent | Explicit terminal `deliveryOutcome: no_parent_audience`; no parent notification. Subsequent allocation produces its own event ID. |
| Unknown event or rejected malformed parent event | Mapping throws; no send or delivered acknowledgement. Persisted retry state retains the error and next attempt time. Unknown events with no parent are also rejected rather than treated as unallocated receipts. |

Wallet balance fields are validated as bounded nonnegative integers, including zero. Their nested cash/settlement values and timestamps are forwarded unchanged; the mapper does not reconstruct financial results. Refund notification means the native wallet outflow was posted, not external bank payout confirmation.

Legacy hub calls retain `{ type, data, timestamp }`. Outbox delivery adds top-level `eventId` and `processedAt`. Parent financial data goes only to the normalized parent room, never broadcast.

## Durability and delivery semantics

- Atomic `findOneAndUpdate` claims increment attempts and persist a random lease token, claimed time, and expiry. State writes request majority write concern.
- Eligible rows have null/missing delivered time, due/null next attempt time, and expired/null lease. Concurrent consumers compete on the same atomic claim.
- Acknowledgement and retry updates require the matching token and an unexpired lease. Expired/stale owners cannot overwrite a new owner's state.
- Retry delay grows exponentially from 1 second to a 5-minute cap by default. Attempts are not discarded after a fixed count. Unknown/malformed events therefore remain visible and retryable; operators should supply `onError` and monitor retry state. Its default callback is a no-op.
- If retry persistence fails, the original lease remains recoverable on expiry. There is no lease renewal; sends longer than the lease can be repeated by another consumer.
- A process death after sending but before persisting acknowledgement can repeat the notification with the **same eventId and committed payload**. Delivery is at-least-once dispatch, not exactly-once receipt or a client ACK.
- Hub success means local send callbacks completed for the selected open sockets. Offline rooms and socket errors cause retry. A partial send can duplicate delivery to sockets that already succeeded.
- Clients deduplicate by `eventId` and refresh authoritative summaries, particularly after reconnect. Delayed snapshots may arrive out of order; events must not trigger financial operations.
- The worker receives only the outbox collection and a delivery function. It does not call accounting/settlement operations or update financial collections.

## Lifecycle and deployment boundary

Import/construction performs no I/O and starts no timer. `initialize()` explicitly creates the dispatch index; `runOnce()` explicitly processes at most one claim; `start()` explicitly starts polling; `stop()` cancels polling and waits for its in-flight iteration. Dependencies include collection, delivery, clock, token factory, scheduling, and error reporting.

There is no application startup import/binding or production activation. A future caller must explicitly choose the repository collection, initialize the index where approved, inject `event => wsHub.sendOutboxEvent(event)`, provide error reporting, and own shutdown. The native repository's isolated-database gate is unchanged; this generic consumer does not independently enforce that gate.

## Test evidence

Executed from `/home/leco/ngochoang/repos/sme2`:

```sh
node --test scripts/accountingOutbox.test.js
```

Result on 2026-09-27: **10 tests passed, 0 failed, 0 skipped** (7 Mongo subtests plus their enclosing test, lifecycle, and hub tests); duration approximately 2.94 seconds. Runtime emitted a dependency `punycode` deprecation warning.

Coverage:

1. Twelve independent consumers produce one claim winner; delivered state is terminal.
2. Claim-before-send crash, lease expiry, reclaim, and stale-owner fencing.
3. Send-before-ACK crash repeats exact event ID, processing timestamp, and payload.
4. Persisted exponential retries, delay cap, and fresh-worker recovery.
5. Retry-write failure and expired-sender acknowledgement fencing.
6. Both native wallet response shapes survive crash and transport retry with exact deep equality, including zero balances and singular settlement/no cash movement.
7. Unknown events with/without a parent and malformed wallet shapes remain undelivered across repeated attempts, with persisted errors and no sends.
8. Construction is idle; start is idempotent; stop waits for in-flight work.
9. Correct parent-room routing, legacy frame compatibility, both wallet frames, closed sockets, callback failure, and offline rooms.

Mongo coverage uses a real disposable `mongo:7.0` **standalone** container and an `accounting_fixture_outbox_*` database with tmpfs storage. The container is stopped/removed in cleanup. It does not read `.env` or an external database URI. Native response fixtures mirror the inspected producer contract; this suite does **not** invoke the native accounting operations, test transaction production end-to-end, or prove replica-set failover durability. Socket delivery and process crash points are simulated; claim/retry/delivered persistence and competing claims execute against real Mongo.

No shared `accountingMongo.js` or `settlement.js` edits, live database mutations, production service restarts, or commits were made for this update.
