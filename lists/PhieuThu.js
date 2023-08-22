const { Slug, Text, Checkbox, Relationship,Integer, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');
module.exports = {
    fields: {
        code: {
            type: Text
        },
        total: {
            type: Integer
        },
        parent: {
            type: Relationship,
            ref: "Parent",
            many: false
        },
        createdAt: {
            type: DateTime
        },
        updateAt: {
            type: DateTime
        },
        ghichu: {
            type: Text
        },
        itemThu: {
            type: Text
        },
        idItemThu: {
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
                    resolvedData.code = await code.getCode(context, "PTT");
                } else {

                }
                resolvedData.createdAt = (new Date()).toISOString();
                resolvedData.updateAt = (new Date()).toISOString();
            }  
            const user = context.authedItem;
            if (user) {
                if (operation === 'create') {
                    resolvedData.createdBy = user.id;
                } else if (operation === 'update') {
                    resolvedData.updatedBy = user.id;
                }
            }
            return resolvedData;
        },
        beforeChange: async ({operation, resolvedData, existingItem, context}) => {
            if(operation == "update"){
                var parent = await code.getParent(context, existingItem.parent);
                var debt = parent.debt;
                if(debt == null){
                    debt = 0;
                }
                debt -= parseInt(resolvedData.total);
                debt += parseInt(existingItem.total);
                code.updateParentDebt(context, {
                    id: parent.id,
                    debt: debt
                });
                resolvedData.updateAt = (new Date()).toISOString();
            }      
        },
        afterChange: async ({operation, resolvedData, existingItem, updatedItem, context}) => {
            if(operation == "create"){
                // console.log("CREATE", "updatedebt");
                await code.updateDebtParentByLog(context, {
                    type: "DOWN",
                    valueDebt: updatedItem.total,
                    item: "Parent",
                    idItem: updatedItem.parent,
                    itemS: "PhieuThu",
                    idItemS: updatedItem.id,
                    actionLog: "CREATE"
                });
            }
            // updatedItem
        },
        beforeDelete: async ({operation, resolvedData, existingItem, context}) => {
            await code.updateDebtParentByLog(context, {
                type: "UP",
                valueDebt: existingItem.total,
                item: "Parent",
                idItem: existingItem.parent,
                itemS: "PhieuThu",
                idItemS: existingItem.id,
                actionLog: "DELETE"
            });
        },
    }
};