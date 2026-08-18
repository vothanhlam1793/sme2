const { Slug, Text, Checkbox, Relationship } = require('@keystonejs/fields');

module.exports = {
    fields: {
        key: {
            type: Text
        },
        slug: {
            type: Slug
        },
        value: {
            type: Text
        },
        item: {
            type: Text
        },
        idItem: {
            type: Text
        }
    },
    access: {
        auth: true,
    },
    labelField: "key",
};