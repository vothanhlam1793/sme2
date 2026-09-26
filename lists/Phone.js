const { Text, Checkbox, Relationship } = require('@keystonejs/fields');

module.exports = {
    fields: {
        number: {
            type: Text,
            isRequire: true,
            isUnique: true
        },
        parent: {
            type: Relationship,
            ref: "Parent.phone",
            many: false
        },
        name: {
            type: Text,
        },
        camera: {
            type: Text,
            defaultValue: "NO" 
        },
        note: {
            type: Text,
            defaultValue: ""
        }
    },
    access: {
        auth: true,
    },
    hooks: {
        validateInput: async ({ operation, resolvedData }) => {
            if (resolvedData.number !== undefined && typeof resolvedData.number === 'string') {
                resolvedData.number = resolvedData.number.replace(/\D/g, '');
            }
            if (resolvedData.name !== undefined && typeof resolvedData.name === 'string') {
                resolvedData.name = resolvedData.name.trim().replace(/\s+/g, ' ');
            }
            if (resolvedData.note !== undefined && typeof resolvedData.note === 'string') {
                resolvedData.note = resolvedData.note.trim();
            }
            return resolvedData;
        }
    },
    labelField: "number"
};