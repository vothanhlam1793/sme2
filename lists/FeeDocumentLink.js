const { Text, Select, Relationship, DateTime } = require('@keystonejs/fields');
const { access } = require('../setting/access');
const { configureFeeDocumentLinkSchema, DOCUMENT_TYPES } = require('../func/feeDomain');

const options = values => values.map(value => ({ value, label: value }));

module.exports = {
  adapterConfig: { configureMongooseSchema: configureFeeDocumentLinkSchema },
  fields: {
    fee: { type: Relationship, ref: 'Fee.documentLinks', many: false, isRequired: true },
    documentType: { type: Select, options: options(DOCUMENT_TYPES), isRequired: true },
    documentId: { type: Text, isRequired: true },
    status: { type: Select, options: options(['ACTIVE', 'DETACHED']), defaultValue: 'ACTIVE', isRequired: true },
    attachedAt: { type: DateTime },
    attachedBy: { type: Relationship, ref: 'User', many: false },
    detachedAt: { type: DateTime },
    detachedBy: { type: Relationship, ref: 'User', many: false },
    detachReason: { type: Text }
  },
  access: { read: access.userIsAdmin, create: false, update: false, delete: false }
};
