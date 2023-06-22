const { Slug, Text, Checkbox, Relationship, Integer } = require('@keystonejs/fields');
const code = require('../func/code');
module.exports = {
    fields: {
        co: {
            type: Relationship,
            ref: "Student",
            many: true
        },
        khong: {
            type: Relationship,
            ref: "Student",
            many: true
        },
        // Nguoi diem danh
        giaovien: {
            type: Relationship,
            ref: "User",
            many: false
        },
        code: {
            type: Text,
        },
        lophoc: {
            type: Relationship,
            ref: "LopHoc",
            many: false
        },
        // Cac loai phieu
        type: {
            type: Text
        },
        // Trang thai phieu
        status: {
            type: Text,
        },
        // Note
        note: {
            type: Text
        }
    },
    hooks: {
        
    }
};