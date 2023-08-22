const { Slug, Text, Checkbox, Relationship, Integer } = require('@keystonejs/fields');
const code = require('../func/code');
module.exports = {
    fields: {
        khongan: {
            type: Relationship,
            ref: "Student",
            many: true
        },
        an: {
            type: Relationship,
            ref: "Student",
            many: true
        },
        giaovien: {
            type: Relationship,
            ref: "User",
            many: true
        },
        code: {
            type: Text,
        },
        date: {
            type: Integer
        },
        lophoc: {
            type: Relationship,
            ref: "LopHoc",
            many: false
        },
        status: {
            type: Text,
        }
    },
    hooks: {
        
    }
};