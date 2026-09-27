// Error propagation only: Keystone GraphQL operations are NOT transactional.
// Earlier writes may already persist when this throws; callers must not blindly retry.
module.exports = async function executeAccounting(context, options) {
    const operation = options.query.definitions.find(def => def.kind === 'OperationDefinition');
    const fields = operation.selectionSet.selections;
    const result = await context.executeGraphQL(options);
    if (!result || result.errors?.length || !result.data || fields.some(field => {
        const value = result.data[(field.alias || field.name).value];
        return !value || !value.id;
    })) {
        // Do not expose GraphQL internals, credentials or financial payloads to clients.
        const error = new Error('Accounting GraphQL operation failed; partial writes may require reconciliation');
        error.code = 'ACCOUNTING_GRAPHQL_FAILED';
        throw error;
    }
    return result;
};
