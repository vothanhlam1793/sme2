// Offline only. Input is an explicitly supplied JSON export, never application env.
const fs = require('fs');
const { providerIdentity } = require('../func/accountingIdentity');

const integer = value => Number.isSafeInteger(value);
const id = value => typeof value === 'string' ? value : value && (value.id || value.$oid);

function audit(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.parents)) throw new Error('parents export is required');
    const issues = [];
    const identities = new Map();
    const cash = snapshot.cashTransactions || [];
    const settlements = snapshot.settlements || [];
    const logs = snapshot.logs || [];
    const openings = snapshot.openings || [];
    const events = snapshot.events || [];
    const known = new Set(snapshot.parents.map(p => id(p.id || p._id)));
    if (!snapshot.parents.length) issues.push({ kind: 'EMPTY_PARENT_EXPORT' });
    if (known.size !== snapshot.parents.length || known.has(undefined)) issues.push({ kind: 'INVALID_OR_DUPLICATE_PARENT_ID' });
    const eventIds = new Set();
    for (const event of events) {
        if (!known.has(event.parentId) || !event.id || eventIds.has(event.id)) issues.push({ kind: 'ORPHAN_OR_DUPLICATE_EVENT', id: event.id });
        eventIds.add(event.id);
    }
    for (const opening of openings) {
        if (!known.has(opening.parentId)) issues.push({ kind: 'ORPHAN_OPENING', parentId: opening.parentId });
    }
    for (const tx of cash) {
        if (!integer(tx.amount) || tx.amount <= 0) issues.push({ kind: 'INVALID_CASH_AMOUNT', id: id(tx.id || tx._id) });
        if (tx.parent && !known.has(id(tx.parent))) issues.push({ kind: 'ORPHAN_CASH', id: id(tx.id || tx._id) });
        if (['ACB_BANK', 'MONA_PAY'].includes(tx.paymentMethod)) {
            try {
                const key = providerIdentity(tx);
                if (identities.has(key)) issues.push({ kind: 'DUPLICATE_PROVIDER_IDENTITY', ids: [identities.get(key), id(tx.id || tx._id)] });
                identities.set(key, id(tx.id || tx._id));
            } catch (_) { issues.push({ kind: 'MISSING_PROVIDER_IDENTITY', id: id(tx.id || tx._id) }); }
        }
        if (!['UNALLOCATED', 'ALLOCATED', 'CANCELLED'].includes(tx.status) ||
            (tx.status === 'UNALLOCATED' && tx.parent) || (tx.status === 'ALLOCATED' && !tx.parent)) {
            issues.push({ kind: 'AMBIGUOUS_CASH_STATE', id: id(tx.id || tx._id) });
        }
    }
    for (const st of settlements) {
        if (!known.has(id(st.parent)) || !integer(st.amount) || st.amount <= 0 || st.status !== 'SUCCESS') {
            issues.push({ kind: 'UNRESOLVED_SETTLEMENT', id: id(st.id || st._id) });
        }
        if (st.cashTransaction) {
            const tx = cash.find(t => id(t.id || t._id) === id(st.cashTransaction));
            if (!tx || tx.type !== 'INFLOW' || id(tx.parent) !== id(st.parent)) {
                issues.push({ kind: 'INVALID_SETTLEMENT_CASH_LINK', id: id(st.id || st._id) });
            }
        }
    }
    const parents = snapshot.parents.map(parent => {
        const parentId = id(parent.id || parent._id);
        const reasons = [];
        const opening = openings.filter(o => o.parentId === parentId);
        const entries = events.filter(e => e.parentId === parentId);
        const observed = { debt: parent.debt, wallet: parent.balance };
        if (!parentId || !integer(parent.debt) || !integer(parent.balance)) reasons.push('INVALID_PARENT_TOTALS');
        if (opening.length !== 1 || !integer(opening[0].debt) || !integer(opening[0].wallet) || !opening[0].evidence) {
            reasons.push('MISSING_VERIFIED_OPENING');
        }
        // Coverage is a reviewer assertion in the export, not something legacy logs prove.
        if (!snapshot.coverage || snapshot.coverage[parentId] !== 'REVIEWED_COMPLETE') reasons.push('UNPROVEN_EVENT_COVERAGE');
        const seen = new Set();
        for (const event of entries) {
            if (!event.id || seen.has(event.id) || !event.evidence || !integer(event.debtDelta) || !integer(event.walletDelta)) reasons.push('INVALID_OR_DUPLICATE_EVENT');
            seen.add(event.id);
        }
        let expected = null;
        if (!reasons.length) {
            expected = entries.reduce((sum, event) => ({ debt: sum.debt + event.debtDelta, wallet: sum.wallet + event.walletDelta }),
                { debt: opening[0].debt, wallet: opening[0].wallet });
            if (!integer(expected.debt) || !integer(expected.wallet)) { reasons.push('TOTAL_OVERFLOW'); expected = null; }
        }
        return {
            parentId, observed, expected,
            debt: expected ? (expected.debt === observed.debt ? 'MATCH' : 'MISMATCH') : 'UNKNOWN',
            wallet: expected ? (expected.wallet === observed.wallet ? 'MATCH' : 'MISMATCH') : 'UNKNOWN',
            reasons,
            legacyEvidence: {
                cashCount: cash.filter(t => id(t.parent) === parentId).length,
                settlementCount: settlements.filter(s => id(s.parent) === parentId).length,
                debtLogCount: logs.filter(l => l.item === 'Parent' && l.idItem === parentId && l.key === 'debt').length
            }
        };
    });
    const incomplete = ['cashTransactions', 'settlements', 'logs'].filter(k => !Array.isArray(snapshot[k]));
    if (incomplete.length) issues.push({ kind: 'INCOMPLETE_EXPORT', fields: incomplete });
    return { status: issues.length || parents.some(p => p.debt !== 'MATCH' || p.wallet !== 'MATCH') ? 'REVIEW_REQUIRED' : 'MATCH_AGAINST_SUPPLIED_EVIDENCE',
        caveat: 'Offline snapshot only; completeness and opening evidence require independent review. Legacy debt logs cannot establish wallet correctness. No repair performed.', parents, issues };
}

if (require.main === module) {
    try {
        if (process.argv.length !== 3) throw new Error('Usage: node scripts/auditAccounting.js /path/to/export.json');
        const report = audit(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
        console.log(JSON.stringify(report, null, 2));
        if (report.status !== 'MATCH_AGAINST_SUPPLIED_EVIDENCE') process.exitCode = 2;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { audit };
