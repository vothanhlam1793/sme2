// Exact strings: never coerce numeric account/reference values (leading zeros).
function text(value, name) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256) {
        throw new Error(`Invalid ${name}`);
    }
    return value;
}

function providerIdentity({ paymentMethod, receivingAccount, providerReference, bankRef }) {
    const provider = text(paymentMethod, 'paymentMethod');
    const account = text(receivingAccount, 'receivingAccount');
    const reference = text(providerReference, 'providerReference');
    text(bankRef, 'bankRef');
    // Tuple encoding is collision-free even if components contain separators.
    return JSON.stringify([provider, account, reference]);
}

module.exports = { providerIdentity };
