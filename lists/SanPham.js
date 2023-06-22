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
        }
    }
};