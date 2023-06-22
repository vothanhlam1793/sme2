const { Slug, Text, Checkbox, Relationship, Integer, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');
module.exports = {
    fields: {
        data: {
            type: Text,
        },
        code: {
            type: Text,
        },
        lophoc: {
            type: Relationship,
            ref: "LopHoc",
            many: false
        },
        phieuketso: {
            type: Relationship,
            ref: "PhieuKetSo.items",
            many: false
        },
        hocsinh: {
            type: Relationship,
            ref: "Student"
        },
        createdAt: {
            type: DateTime
        },
        total: {
            type: Integer
        }
    },
    hooks: {
        resolveInput: async ({operation, resolvedData, existingItem, context}) => {
            // Tim thong tin hoc sinh
            if(operation == "create"){

            }
            return resolvedData;
        },
        afterChange: async ({operation, resolvedData, existingItem, updatedItem, context}) => {
            if(operation == "create"){
                var student = await code.getStudent(context, updatedItem.hocsinh);
                await code.updateDebtParentByLog(context, {
                    type: "UP",
                    valueDebt: updatedItem.total,
                    item: "Parent",
                    idItem: student.parent.id,
                    itemS: "ItemKetSo",
                    idItemS: updatedItem.id,
                    actionLog: "CREATE"
                });
            }
        },
        beforeChange: async ({operation, resolvedData, existingItem, context}) => {
            // console.log("UPDATE", operation, resolvedData, existingItem);
            if(operation == "update"){
                var reso = JSON.parse(resolvedData.data);
                var student = await code.getStudent(context, existingItem.hocsinh);
                await code.updateDebtParentByLog(context, {
                    type: "UP",
                    valueDebt: reso.total,
                    item: "Parent",
                    idItem: student.parent.id,
                    itemS: "ItemKetSo",
                    idItemS: existingItem.id,
                    actionLog: "UPDATE"
                });

                // Cap nhat hoa don voi phieu ket so
                await code.updateHoaDonWithItemKetSo(context, reso, existingItem);
            }
            return resolvedData;
        },
        beforeDelete: async ({existingItem, context}) => {
            var student = await code.getStudent(context, existingItem.hocsinh);
            await code.updateDebtParentByLog(context, {
                type: "DOWN",
                valueDebt: existingItem.total,
                item: "Parent",
                idItem: student.parent.id,
                itemS: "ItemKetSo",
                idItemS: existingItem.id,
                actionLog: "DELETE"
            });

            await code.updateHoaDonWithItemKetSo(context, 
                {
                    hoadons: [],
                },
                existingItem
            );
        }         
    }
};