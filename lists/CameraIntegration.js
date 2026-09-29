const { Text } = require('@keystonejs/fields');

// Only the authenticated management router's server-side context can access keys.
module.exports = {
  fields: {
    key: { type: Text, isRequired: true, isUnique: true },
    value: { type: Text, isRequired: true },
  },
  access: { read: false, create: false, update: false, delete: false },
};
