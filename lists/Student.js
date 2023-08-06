const { Text, Checkbox, Relationship, DateTime } = require('@keystonejs/fields');

function chuyentiengviet(str) {
    return str.normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

module.exports = {
    fields: {
        name: {
            type: Text,
        },
        sName: {
            type: Text
        },
        status: {
            type: Text
        },
        parent: {
            type: Relationship,
            ref: "Parent.hocsinhs",
            many: false,
        },
        lophoc: {
            type: Relationship,
            ref: "LopHoc.hocsinhs",
            many: false
        },
        hocphi: {
            type: Text
        },
        namhocphi: {
            type: Text
        },
        luuy: {
            type: Text
        },
        birthday: {
            type: DateTime
        },
        hocphigiam: {
            type: Text,
            defaultValue: "0"
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
            if(operation == "create"){
                if(resolvedData.status == undefined){
                    resolvedData.status = "DANG_KY"
                } else {

                }
            }  
            if(resolvedData.name){
                var s = resolvedData.name.split(" ");
                s = s[s.length - 1];
                resolvedData.sName = chuyentiengviet(s);
            }
            const user = context.authedItem;
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