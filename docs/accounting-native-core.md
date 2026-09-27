# Native accounting increment — isolated opt-in only

## Delivered boundary

`func/accountingMongo.js` implements external `MONA_PAY` / `ACB_BANK` receipts
and allocation of **new, repository-created** uncredited receipts, wallet refunds/
outflows, and wallet-to-debt transfers. Every read and
write in an operation uses one Mongo session: cash, parent totals, settlement FK,
debt log, code counters, durable response and outbox. It uses connected Keystone
list models' collections, never guessed collection names or GraphQL mutations.
Keystone hooks are deliberately not invoked; there is exactly one parent/log
writer inside this boundary. Existing GraphQL execution remains non-transactional.

The repository verifies real-key relationship metadata at construction. Parent,
createdBy and settlement cashTransaction/parent/settledBy are local scalar FKs;
cash.settlements is the reverse relation derived from settlement.cashTransaction,
not a stored cash array. Tests read that reverse relation through real Keystone
GraphQL after commit. Changes in adapter layout fail construction.

`CashTransaction.adapterConfig.configureMongooseSchema` registers private Mongo
fields and unique `accounting_provider_account_reference` index on
`{paymentMethod, receivingAccount, providerReference}`, partial on
`accountingVersion: 1`. These fields are not GraphQL mutation inputs. The index
survives adapter `syncIndexes()`. No existing row is automatically marked verified.
**A future application startup with this schema will synchronize this index**;
deployment/index review is still required. This session only created it in test DBs.

Provider identity is exact/case-sensitive and separately scoped by paymentMethod
and account; bankRef remains the original display reference. Upstream must supply
canonical provider/account/ref consistently. The same bank event under two provider
names is not automatically equated. No generated fallback external reference.

Durable operation `_id`s are derived from the scoped identity (receipt) or cash ID
(allocation); receipt request fingerprints include scoped identity and economic
intent (amount/parent/autoSettle), excluding delivery/operator `settleType` provenance.
Manual fallback (`MANUAL_ACCOUNTANT`) followed by webhook (`AUTO_ACB`) replays the
original committed outcome when economic intent matches. The first committed
intent, settlement type, notes and response remain unchanged for audit. Changed
amount, parent or autoSettle conflicts. Allocation still fingerprints settleType;
wallet-transfer command semantics are described below.
Different economic intent conflicts; retries return the original response snapshot.
Notes, display bankRef and retry actor are not economic identity. An unassigned
receipt later allocated still replays its original unassigned receipt outcome;
allocation is a separate operation. Existing credited receipt cannot be allocated
again. Legacy/cancelled/outflow/assigned rows require review and cannot be claimed.

Parent read and write use the same snapshot transaction; competing native writers
cause Mongo write conflicts and retry against current totals. Integer amounts and
totals are bounded to GraphQL Int, with no truncation/clamping. Codes are allocated
transactionally in repository-owned counters, `CT-TX-0000000001` and
`STL-TX-0000000001`. This intentionally avoids collision with `func/code.js`'s
non-atomic Variable `CTCODE`/`STLCODE` six-digit namespace. Counter rollback is tested.

Driver `withTransaction` retries transient conflicts and unknown commit results;
duplicate-key races retry a fresh transaction (bounded to eight attempts). No
success is inferred if an error remains unresolved. Stable-key retry reads the
committed response. Outbox persistence is atomic. `func/accountingOutbox.js` now
provides a lease-based retryable delivery worker, but it is **not wired into
application startup**. Its current event mapper supports `PAYMENT_RECEIVED` and
its no-audience branch supports `CASH_RECEIVED_UNALLOCATED`; it does not yet support
the new `WALLET_REFUNDED` / `WALLET_DEBT_SETTLED` events. Those events persist correctly
but would enter worker retry on unsupported-event errors if consumed as-is. Extend
the mapper/client event contract and tests before enabling dispatch. There is no
direct broadcast from native accounting and no exactly-once delivery claim.

### Wallet operation contract

`processOutflow(context, { operationId, parentId, amount, paymentMethod, reason,
userId })` and `transferBalanceToDebt(context, { operationId, parentId, amount,
settleType, note, userId })` are runnable native operations for bound contexts.
Both require a nonempty, trimmed stable `operationId` (maximum 200 characters).
The caller must durably persist it before first submission and reuse it on retries.
The shared `wallet:<operationId>` unique operation key prevents reusing the ID for
another command kind. Fingerprints include kind, parent, amount and payment method
(refund) or settlement type (transfer). Notes/reason and retry actor are metadata;
they do not change the committed economic intent. Failed/aborted operations do not
reserve an ID or save a rejection outcome: a retry can succeed after funds arrive.

Refunds debit only available wallet funds, never debt, and record an OUTFLOW cash
row. They do **not** reverse a historical settlement or execute a bank payout.
Native outflow status is `ALLOCATED`: posted to the identified parent's wallet,
not external disbursement confirmation. `accountingVersion: 2` and
`accountingOperationId` mark these wallet outflows, outside the version-1 external
receipt identity index. No provider identity is fabricated. This isolated state
interpretation requires approval/UI review before production migration; legacy
outflows still use their existing invalid `SETTLED` enum value.

Transfers reduce balance and debt together, insert a settlement and debt log, and
create no new cash transaction or cash FK. Explicit positive integer amounts are
exact: insufficient balance/debt rejects rather than silently clipping. A null or
omitted amount settles the maximum at first successful commit; retry returns that
snapshot even after balances change. This differs deliberately from legacy
explicit-amount clipping and needs caller contract review before cutover. Both
operations atomically save their response and distinct event in the outbox.

## Explicit opt-in and gating

There is no environment toggle, automatic route binding or production bootstrap.
Constructing the repository requires `isolated: true` AND a connected database
named `accounting_fixture_*`. This is a development gate, not an authorization
mechanism. Only trusted code may construct/bind a repository; authorization remains
the caller's responsibility. Do not attach normal financial UI/routes to a fixture
database with competing legacy writers.

```js
const { AccountingMongo, bindContext } = require('../func/accountingMongo');
const repo = await new AccountingMongo(keystone, { isolated: true }).initialize();
bindContext(context, repo);
await SettlementService.processInflowAndSettle(context, verifiedReceipt);
await SettlementService.allocateCashTransaction(context, allocation);
await SettlementService.processOutflow(context, { operationId: 'refund-source-1', parentId, amount: 100 });
await SettlementService.transferBalanceToDebt(context, { operationId: 'transfer-command-1', parentId, amount: null });
```

The existing service signatures and response shapes are retained. Only explicitly
bound contexts dispatch to the native methods. For bound contexts, cash/other
inflows, bill posting and standalone debt-log writes reject
explicitly, never fall back to GraphQL. Unbound contexts retain current behavior.
The WeakMap binding is process-local and must not be expected to propagate to new
contexts created by Keystone. It is not a GraphQL hook transaction wrapper.

## Writer inventory and remaining integration

Reviewed application JS writers/callers (excluding dependencies/build output):

| Writer / entry | Current status and required migration |
| --- | --- |
| `func/settlement.js` receipt + allocation | Native only for bound isolated contexts; legacy GraphQL branch remains for current callers. |
| `func/settlement.js` outflow, balance-to-debt transfer | Native stable-ID commands implemented/tested for bound fixture contexts; existing unbound callers stay legacy. Must persist caller command IDs, authorize parent/amount, review outflow status and exact-transfer semantics, and reconcile historical partial debits before binding. |
| `func/settlement.js` bill posting, standalone debt log | Unmigrated; bound contexts reject. Requires source/outcome atomicity and bill/reversal retry tests. |
| `lists/PaymentSettlement.js` afterChange | Direct GraphQL creation independently changes parent and writes log; can duplicate service effects. Native insertion bypasses it. Migrate direct create/update/delete and reversal semantics before cutover. |
| `lists/PhieuThu.js` afterChange | Unchanged: source persists before inflow/refund and hook supplies no operationId. Do not simply bind this hook: native refund would reject after source save. First move source creation + stable source-derived operation ID + accounting + outcome into one transaction, reconcile already-saved receipts, and define update/delete reversals. Existing propagated errors do not roll back source. |
| `lists/HoaDon.js` afterChange | Bill then immediate CASH receipt are separate calls after source save. Update/delete lack coordinated accounting reversals. Migrate source/items and combined payment. |
| `lists/ItemKetSo.js` afterChange/beforeChange/beforeDelete | Posts monthly debt; edits/deletes call `code.updateHoaDonWithItemKetSo`, which edits/deletes invoices with async loops. Coordinate source/invoice relationships and avoid monthly/invoice double counting. |
| `lists/Parent.js` | Authenticated direct debt/balance writes and creation initialization; deletion has unrelated async phone cleanup. Financial edits/deletion need authority ownership; retain ordinary profile edits. |
| `lists/CashTransaction.js`, `PaymentSettlement`, `Log`, source lists | `auth:true` direct GraphQL CRUD still permits ledger/status/relationship tampering outside native transactions. Must establish field/operation ownership and migration policy. |
| `func/code.js` | `updateParentDebt`, queued `updateDebtParentByLog` / `updateRunDebtParentByLog` CREATE/UPDATE/DELETE adjust logs and parent; UPDATE/DELETE have unawaited log loops. Legacy queue has no current external JS call site found, but remains callable. `getCode` is non-atomic read/update Variable. |
| `scripts/sync-parent-debt-with-log.js` | Administrative GraphQL debt repair writer; must not compete with new authority or infer wallet correctness from logs. |
| `routes/paymentHub.js` | Route owner must remove bankRef-only duplicate-success shortcut, bind authorized native contexts after production migration, supply canonical scoped identity, and acknowledge only durable outcome. Existing shortcut bypasses fingerprint checks. Not edited here. |
| `routes/parentPortal.js` | Existing payment service caller lacks the native production binding/identity contract; source checkout/delivery ID must not become bank event identity. |
| `extend/g.js` | Reviewed parent queries/create plus phone relationship updates; no direct debt/balance update found. Its document creation paths still invoke list hooks and must be covered by source migration. |
| `routes/wsHub.js`, audit scripts | Financial reads/diagnostics, not balance writers. Outbox dispatcher integration remains separate. |
| `func/accountingOutbox.js` | Delivery worker exists but is unwired; extend wallet event mapping, notification contract/client deduplication and worker tests before dispatching the new events. No financial writes. |

Thus concurrent **legacy** writes can still overwrite native results if mixed on
one parent. No production consistency claim: do not remove the fixture gate until
all competing financial writes are migrated/protected, historical openings and
ambiguous cash are reconciled, routes use committed outcomes, source-document tests
pass, and the existing outbox worker is extended and explicitly wired. Do not disable all finance
as a substitute for this migration.

## Exact verification (2026-09-27)

```
node --test scripts/accountingMongo.test.js
node --test scripts/settlementErrors.test.js scripts/auditAccounting.test.js scripts/paymentHubSecurity.test.js scripts/parentPortalErrors.test.js scripts/accountingOutbox.test.js
```

Native suite: **17/17 passed** (16 subtests plus enclosing test). Regression
and outbox suites: **48/48 passed**, including parent portal's internal 33 response cases
and the existing worker's real-Mongo claim/retry/fencing tests.
Native suite starts its own `mongo:7.0` replica-set container with tmpfs db/config,
no host mounts or published ports; connects only to its inspected container IP
and unique fixture DB. It imports real owned list definitions, not application
`index.js` or `.env`. Finally disconnects and stops/removes its container.

Coverage: parallel duplicate/distinct receipts, same-parent contention, amount and
parent fingerprint conflicts, account-scoped reference, actual unique-index
enforcement, manual-fallback/webhook provenance replay preserving original audit,
survival of syncIndexes, GraphQL reverse relationship visibility,
rollback after all eight receipt and seven allocation write stages (including
counter/outcome/outbox), same/different-parent allocation races, legacy/cancelled/
outflow/credited rejection, no-auto allocation, lost post-commit acknowledgement
replay from fresh repository, and a server failpoint returning an actual
UnknownTransactionCommitResult. Additional wallet coverage includes duplicate
stable IDs, changed-intent/cross-kind conflicts, concurrent refund/receipt and
refund/refund races, refund/transfer contention, transfer/receipt conservation,
rollback at all five refund and six transfer write stages, fresh-repository
replay after lost acknowledgement, exact limits, maximum snapshot replay and
retry after insufficient funds. Test-only fault callbacks are not external APIs.

Not covered/implemented: all-writer cutover, transactional PhieuThu/HoaDon/ItemKetSo
sources, bill retries, live topology/index readiness,
legacy data repair, native wallet-event delivery integration or literal OS process-kill recovery. Fresh
repository replay proves persisted outcome use but is not a process-kill test.
No live mutations, application restarts, migration or commit were performed.
