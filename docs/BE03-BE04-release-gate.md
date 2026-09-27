# BE03/BE04 follow-up: error propagation repair, atomicity still open

> Subsequent increment: [Native isolated core](accounting-native-core.md) now
> implements and tests session-bound external receipts/allocation plus stable-ID
> wallet refunds/outflows and wallet-to-debt transfers against a real
> disposable replica set. Production BE03/BE04 remain open. The historical
> error-propagation work below and its all-writer release gate still apply; native
> receipts/allocation now satisfy part of that gate within an isolated opt-in
> boundary only. See the linked writer inventory, tests and remaining integration.

## Implemented

- `func/accountingGraphQL.js` checks the single-record operations used by the
  settlement service and settlement hook. GraphQL errors (including partial data),
  absent data, null records and missing IDs reject rather than acknowledge success.
  The original context/receiver and access checks are preserved.
- Every GraphQL step in `func/settlement.js` uses that check. A failed journal,
  Parent update, settlement or cash-status update stops subsequent service steps
  and payment-success broadcasts. Fabricated allocation-response fallbacks are removed.
- Debt-log, PaymentSettlement and PhieuThu hooks propagate accounting exceptions.
  **Source documents and earlier writes can already exist when errors return.**
  This change neither rolls them back nor makes retries safe.
- The unallocated cash-status mutation now uses an enum literal, as required by
  the installed Keystone Select implementation (default `dataType: 'enum'`).

Payment-hub route/security work and its tests, UI, schemas and indexes were not
edited by this follow-up. Existing routes await the service, so propagated failures
reach their existing error handlers. The bankRef duplicate fast-path still bypasses
the service and is not evidence of a committed accounting outcome.

## Verification

Run `node --test scripts/settlementErrors.test.js` on Node 18+.
Fixtures are in-memory fake GraphQL responses, never an application DB. Tests
inject errors, partial data with errors, null/missing records, missing IDs and
transport failures at every GraphQL step in inflow, unassigned receipt, outflow,
transfer, bill posting and allocation (including no-auto-settlement branches).
They check propagation through receipt/settlement hooks and absence of subsequent
service operations or success broadcasts. These are **not atomicity tests**.

On 2026-09-27, local Docker was available and `mongo:7.0` was cached. Existing
development container command lines declared `--replSet rs0`; their DBs were not
queried or modified. Native mongod/mongosh were not on PATH. A separate disposable
Mongo 7 container was created with `--network none`, no published ports, no host
mounts and tmpfs-only data/config directories. Inside it, replica set
`accounting_fixture` became primary, a session transaction was aborted with zero
persisted fixture rows, and a second transaction committed one fixture row.
The `--rm` container was stopped and removed after the probe. This proves that
isolated replica-set testing is feasible locally, not that application writes are
transactional or that any deployment topology/indexes are ready.

## Exact release gate for closing BE03/BE04

1. **Migrate all financial writers together.** Adapter `_createSingle`, `_update`
   and relationship writes omit sessions. A context session or transaction around
   executeGraphQL cannot fix this. Introduce a native session-bound authority with
   verified adapter relationship metadata; cover Parent, cash, settlements, journals,
   source documents, operation outcomes and sequence generation in the same session.
2. **Eliminate competing writes without shutting down finance.** Migrate the
   PaymentSettlement afterChange balance/debt/log writer, PhieuThu afterChange
   inflow/refund, HoaDon afterChange bill/immediate payment, ItemKetSo posting,
   directly editable Parent debt/balance and `func/code.js` updateParentDebt and
   legacy CREATE/UPDATE/DELETE debt-log adjustment paths (including unawaited async
   log loops). Review direct list create/update/delete access and callers in
   `routes/paymentHub.js`, `routes/parentPortal.js`, `extend/g.js`, and `func/code.js`.
   A service-only transaction leaves these outside the consistency boundary.
3. **Resolve migration ambiguity before crediting old cash.** Existing rows lack
   provider/account-scoped identity, an allocation-credit marker and durable
   outcomes. Review partial operations and establish evidenced opening wallet/debt
   totals; status/log presence cannot prove whether cash was credited. Resolve
   current outflow `SETTLED` versus CashTransaction's allowed statuses as part of
   the reviewed state model, rather than guessing a replacement here.
4. **Durable identity and outcomes.** Persist unique operation IDs, request
   fingerprints and committed response snapshots atomically. Add reviewed scoped
   provider/account/reference indexes to the adapter schema (its syncIndexes can
   remove ad-hoc indexes). Same identity with different amount/parent must conflict.
   Atomically claim only eligible uncredited inflows; prevent reassignment,
   cancelled/outflow allocation and double-credit retries. Replace route bankRef-only
   duplicate success with confirmed durable outcomes.
5. **Recovery and real application tests.** Handle transient conflicts, uncertain
   commits and process-crash retries using durable outcomes; publish notifications
   through a transactional outbox. Pass isolated replica-set application tests for
   parallel duplicate/distinct payments, same-parent contention, failure after every
   write, lost commit response, allocation/reassignment races, concurrent outflows,
   bill/refund/source retries and relationship rollback. The infrastructure probe
   and mocked error tests do not satisfy this requirement.

No live DB writes, service restarts, commits, migration, index creation or automatic
repair were performed. No unconditional finance guard was installed. BE03/BE04
remain open; only the independently correct error-reporting repair is delivered.
Operators must reconcile partial failures before retrying existing non-idempotent
flows. The earlier `scripts/accounting-cutover.md` describes the prior baseline
restoration; this document records the subsequent limited code repair.
