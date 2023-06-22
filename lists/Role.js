const { Slug, Text, Checkbox, Relationship, Integer } = require('@keystonejs/fields');

module.exports = {
    fields: {
        name: {
            type: Text
        },
        slug: {
            type: Slug
        },
        lophoc: {
            type: Relationship,
            ref: "LopHoc",
            many: true
        },
        level: {
            type: Integer,
            defaultValue: 1
        }
    },
    labelField: "name"
};