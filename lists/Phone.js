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
    labelField: "number"
};