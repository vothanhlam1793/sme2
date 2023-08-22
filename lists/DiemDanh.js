const { Slug, Text, Checkbox, Relationship, Integer, DateTime } = require('@keystonejs/fields');
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
        },
        date: {
            type: DateTime
        },
        createdBy: {
            type: Relationship,
            ref: "User",
            many: false
        },
        updatedBy: {
            type: Relationship,
            ref: "User",
            many: false
        }
    },
    hooks: {
        validateInput: async ({operation, resolvedData, context}) => {
            console.log("VALIDATE");
            resolvedData.note = "HERE";
            if(operation == "create"){
                if(resolvedData.code){
                    var code = resolvedData.code.replace("VT_", "");
                    var dateParts = code.split('_');
                    var dateObject = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
                    var isoString = dateObject.toISOString();
                    resolvedData.date = isoString;
                }
            }
            const user = context.authedItem;
            console.log(context);
            if (user) {
                if (operation === 'create') {
                    resolvedData.createdBy = user.id;
                } else if (operation === 'update') {
                    resolvedData.updatedBy = user.id;
                }
            }
        }    
    }
};