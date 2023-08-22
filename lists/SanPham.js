const { Text, Checkbox, Relationship, Integer } = require('@keystonejs/fields');
const code = require('../func/code');

module.exports = {
    fields: {
        name: {
            type: Text
        },
        price: {
            type: Integer
        },
        type: {
            type: Text
        },
        amount: {
            type: Integer
        },
        code: {
            type: Text,
            isUnique: true
        },
        note: {
            type: Text
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
                if(resolvedData.code == undefined){
                    resolvedData.code = await code.getCode(context, "SP");
                } else {

                }
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