# Accounting QA diagnostics and unresolved atomicity (BE03/04/05/08)

> Historical baseline note: the restoration/diagnostics described below preceded
> the error-propagation repair and the new isolated native receipt/allocation
> implementation. Current readiness, opt-in gate, actual replica-set test results
> and writer inventory are in [accounting-native-core.md](../docs/accounting-native-core.md).
> There is still no production cutover or all-writer atomicity guarantee.

**Full accounting atomicity remains unresolved. BE03, BE04 and BE05 fixes are not
implemented by this work.** The unconditional finance-blocking changes were
withdrawn. `func/settlement.js`, `lists/PaymentSettlement.js` and
`lists/CashTransaction.js` have been restored to baseline HEAD. The blocking guard
and all tests asserting safety by disabling finance have been removed.

Only independent offline audit tooling, its identity diagnostic helper, audit
tests and this documentation remain. Production finance behavior is unchanged
from baseline by this work, including the duplicate settlement afterChange writer.
BE08 provides evidence-limited offline diagnostics, not a completed reconciliation.

## Exact blockers found in source

- `node_modules/@keystonejs/adapter-mongoose/lib/adapter-mongoose.js`: `_createSingle`
  uses `model.create(realData)`; `_update` uses `findByIdAndUpdate` without a session;
  relationship writes also omit sessions. A session on context does not enlist
  GraphQL. No transactional facade is installed by this patch.
- `lists/Parent.js` exposes debt/balance updates through GraphQL. Preventing all
  competing financial writers requires ownership outside these files.
- `lists/HoaDon.js` and `lists/ItemKetSo.js` post debt in afterChange, after the source
  document persists. HoaDon immediate payment is a second independent service call.
- `lists/PhieuThu.js` persists first and catches accounting exceptions. Its refund
  call has no stable operation ID. Thus a saved receipt can look successful after
  an accounting failure. Those source writes remain non-atomic.
- Legacy cash lacks trustworthy provider/account identity, durable operation
  outcomes and an allocation-credit marker. Status alone cannot prove whether a
  prior partial execution credited the wallet. Debt logs can be duplicated or
  absent and never establish a complete wallet history.
- Mongo topology and legacy data have not been inspected against a live DB.
  Replica-set/session support and index readiness are therefore unverified.
- The route agent owns `routes/paymentHub.js`: remove the legacy bankRef-only
  duplicate-success shortcut and only acknowledge a durable committed outcome.
  `bankRef`, `providerReference`, and `receivingAccount` remain separate fields.
  A route-level pre-query is never an atomic uniqueness guarantee.

## Future atomicity implementation/cutover requirements (not implemented or executed)

1. Plan a coordinated migration window for financial ingestion, receipt/invoice
   creation, allocation, refunds, transfers and direct Parent financial edits.
   Any temporary pause must be an explicitly approved operational step, not an
   unconditional application shutdown. Preserve inbound events for reconciliation.
2. Obtain a consistent read-only export and backup with an explicit cutoff. Review
   all historical cash, settlements, invoices, receipts, debt logs, parent totals
   and bank statements. Establish signed opening debt AND wallet balances. Identify
   partial operations and duplicates individually; do not blindly replay, clamp,
   sum all invoice types (monthly/invoice overlap), or infer credits from status.
3. Implement one session-bound native Mongo authority, with every Parent, ledger,
   journal, relationship and outcome write using the SAME session. Verify Keystone
   relationship storage from adapter metadata rather than guessing foreign keys.
   Migrate source hooks and protect Parent financial fields in the same release.
4. Use a supported replica set/sharded deployment. In a controlled migration,
   backfill verified provider/account/reference triples only. Quarantine ambiguous
   records. Create a unique compound index on
   `{paymentMethod:1, receivingAccount:1, providerReference:1}` for verified provider
   receipts (partial filter restricted to verified nonempty identities). Final
   marker/filter must be part of the authority schema. Define the index in the
   adapter schema too: Keystone calls `syncIndexes()` and may drop ad-hoc indexes.
   No unique index or production identity fields are added by this diagnostic work.
5. Add unique operation IDs for cash receipts, refunds, bills and manual transfers;
   persist request fingerprints and committed response snapshots atomically.
   Same identity/different amount or parent must conflict, never return success.
   For allocation, atomically claim only a verified uncredited INFLOW and commit
   parent credit, settlement, logs and outcome together. Same-parent retry returns
   the original outcome; reassignment/reallocation/cancelled/outflow must reject.
   Keep original bankRef and scoped provider identity unchanged throughout.
6. Recovery: retry transient transaction conflicts, resolve unknown commit results
   by the durable unique operation key, and acknowledge only confirmed commits.
   Use a transactional outbox for post-commit notifications. Existing ambiguous
   legacy rows require reviewer decisions, not automatic credit-on-retry.
7. Run real replica-set integration tests: duplicate parallel identity, distinct
   payments to one parent, failure after each write, lost commit response, process
   crash/retry, allocation races/reassignment, outflow races and bill retries.
   Deploy the completed implementation only with verified migration and integration
   results, through the normal approved process. No gates remain from this work.

## Offline audit

`node scripts/auditAccounting.js /absolute/path/export.json`

Input: `parents` with `id,debt,balance`; `cashTransactions`, `settlements`, `logs`
arrays in their exported field shapes (relationship IDs as strings or `{id}`;
Mongo IDs may be `{$oid}`). For reviewed reconciliation also supply:

```json
{
  "openings": [{"parentId":"p","debt":100,"wallet":0,"evidence":"signed opening at cutoff"}],
  "coverage": {"p":"REVIEWED_COMPLETE"},
  "events": [{"id":"operation-1","parentId":"p","debtDelta":-50,"walletDelta":20,"evidence":"reviewed post-cutoff receipt/settlement"}]
}
```

Events must be complete, non-overlapping **post-opening** economic changes; the
tool does not generate them from ambiguous legacy rows. Coverage/evidence are
reviewer assertions, not cryptographic verification. Missing openings/coverage
produce UNKNOWN for both dimensions. MATCH means only agreement with supplied
evidence, never proof of historical correctness. Exit 2 = review required, 1 =
invalid input/error, 0 = match against supplied evidence. No DB connection or repair.

## Tests and limitations

`node --test scripts/auditAccounting.test.js` (Node 18+ test runner).

Tests cover scoped identity diagnostics, empty/orphan exports, missing opening
evidence, independent debt/wallet drift, duplicate evidence and invalid cash links.
They make no claim about production transaction isolation, exactly-once allocation,
rollback or concurrency. No real Mongo transaction test or financial migration
was executed. The identity helper is an offline diagnostic, not an installed
uniqueness lock. No deployment, index creation or migration is needed to run the
offline audit on an already supplied export.
