const { Slug, Text, Checkbox, Relationship, Integer } = require('@keystonejs/fields');
const code = require('../func/code');
module.exports = {
    fields: {
        dihoc: {
            type: Relationship,
            ref: "Student",
            many: true
        },
        nghi: {
            type: Relationship,
            ref: "Student",
            many: true
        }, 
        nghicophep: {
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
        validateInput: async ({operation, resolvedData, context}) => {
            if(operation == "create"){
                if(resolvedData.code == undefined){
                    resolvedData.code = await code.getCode(context, "PDD");
                } else {

                }
            } 
        },
    }
};