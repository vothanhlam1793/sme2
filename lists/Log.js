const { Slug, Text, Checkbox, Relationship, Integer} = require('@keystonejs/fields');

module.exports = {
    fields: {
        item: {
            type: Text
        },
        idItem: {
            type: Text
        },
        key: {
            type: Text,
        },
        value: {
            type: Text
        },
        itemS: {
            type: Text
        },
        idItemS: {
            type: Text
        },
        createdAt: {
            type: Text,
        },
        createdTime: {
            type: Integer
        },
        type: {
            type: Text
        },
        valueChange: {
            type: Text
        }
    },
};