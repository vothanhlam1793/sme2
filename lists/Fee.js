const { Text, Select, Integer, Relationship, DateTime } = require('@keystonejs/fields');
const { access } = require('../setting/access');
const { configureFeeSchema, FEE_SOURCES, FEE_TYPES } = require('../func/feeDomain');

const options = values => values.map(value => ({ value, label: value }));

module.exports = {
  adapterConfig: { configureMongooseSchema: configureFeeSchema },
  fields: {
    code: { type: Text, isRequired: true, isUnique: true },
    businessKey: { type: Text, isRequired: true, isUnique: true },
    status: { type: Select, options: options(['ACTIVE', 'CANCELLED']), defaultValue: 'ACTIVE', isRequired: true },
    source: { type: Select, options: options(FEE_SOURCES), isRequired: true },
    type: { type: Select, options: options(FEE_TYPES), isRequired: true },
    student: { type: Relationship, ref: 'Student', many: false, isIndexed: true },
    parent: { type: Relationship, ref: 'Parent', many: false, isIndexed: true },
    billingMonth: { type: Text },
    schoolYear: { type: Text },
    amount: { type: Integer, isRequired: true },
    evidence: { type: Text },
    documentLinks: { type: Relationship, ref: 'FeeDocumentLink.fee', many: true },
    createdAt: { type: DateTime },
    createdBy: { type: Relationship, ref: 'User', many: false },
    cancelledAt: { type: DateTime },
    cancelledBy: { type: Relationship, ref: 'User', many: false },
    cancellationReason: { type: Text }
  },
  // Mutations go through FeeDomain so attachment/cancellation invariants are atomic.
  access: { read: access.userIsAdmin, create: false, update: false, delete: false }
};
