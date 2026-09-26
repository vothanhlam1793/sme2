const { Text, Checkbox } = require('@keystonejs/fields');

module.exports = {
  fields: {
    key: {
      type: Text,
      isRequired: true,
      isUnique: true,
    },
    value: {
      type: Text,
      isRequired: true,
    },
    description: {
      type: Text,
      defaultValue: '',
    },
    isSecret: {
      type: Checkbox,
      defaultValue: false,
    },
  },
  access: {
    auth: true,
  },
  labelField: 'key',
};
