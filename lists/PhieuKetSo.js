const { Slug, Text, Checkbox, Relationship, Integer } = require('@keystonejs/fields');
const code = require('../func/code');
const { DateTime } = require('@keystonejs/fields/dist/fields.cjs.prod');
module.exports = {
    fields: {
        items: {
            type: Relationship,
            ref: "ItemKetSo.phieuketso",
            many: true
        },
        code: {
            type: Text,
        },
        lophoc: {
            type: Relationship,
            ref: "LopHoc",
            many: false
        },
        status: {
            type: Text
        },
        createdAt: {
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
            if(operation == "create"){
                if(resolvedData.code == undefined){
                    resolvedData.code = await code.getCode(context, "PDD");
                } else {

                }
                resolvedData.createdAt = (new Date()).toISOString();
            } 
            const user = context.authedItem;
            if (user) {
                if (operation === 'create') {
                    resolvedData.createdBy = user.id;
                } else if (operation === 'update') {
                    resolvedData.updatedBy = user.id;
                }
            }
        },
        beforeDelete: async({existingItem, context}) => {
            var pks = await code.getPhieuKetSo(context, existingItem.id);
            var a = pks.items.map(function(e){
                return e.id;
            });
            await code.deleteItemsKetSo(context, a);    
        }
    }
};