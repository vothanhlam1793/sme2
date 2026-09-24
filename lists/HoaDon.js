const { Text, Checkbox, Relationship, Integer, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');
const SettlementService = require('../func/settlement');
const { gql } = require('apollo-server-express');

module.exports = {
    fields: {
        createdAt: {
            type: Text
        },
        items: {
            type: Relationship,
            ref: "Item.hoadon",
            many: true
        },
        total: {
            type: Integer
        },
        giamgia: {
            type: Integer
        },
        code: {
            type: Text,
            isUnique: true
        },
        subCode: {
            type: Text,
        },
        parent: {
            type: Relationship,
            ref: "Parent",
            many: false
        },
        student: {
            type: Relationship,
            ref: "Student",
            many: false
        },
        type: {
            type: Text,
        },
        phieuthu: {
            type: Relationship,
            ref: "PhieuThu",
            many: false
        },
        idItem: {
            type: Text,
            defaultValue: ""
        },
        item: {
            type: Text,
            defaultValue: ""
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
    access: {
        auth: true,
    },
    hooks: {
        validateInput: async ({ operation, resolvedData, context }) => {
            if (operation === "create") {
                if (!resolvedData.code) {
                    resolvedData.code = await code.getCode(context, "HD");
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
            return resolvedData;
        },
        afterChange: async ({ operation, updatedItem, context, originalInput }) => {
            if (operation === "create" && updatedItem.parent && updatedItem.total) {
                // 1. Tăng công nợ debt và tự động cấn trừ nếu có sẵn balance
                await SettlementService.processBillCreated(context, {
                    parentId: updatedItem.parent,
                    amount: updatedItem.total,
                    itemType: 'HoaDon',
                    itemId: updatedItem.id,
                    note: `Phát sinh hóa đơn ${updatedItem.code || ''}`
                });

                // 2. Nếu hóa đơn loại THANHTOAN (thanh toán ngay tại quầy)
                if (updatedItem.type === "THANHTOAN") {
                    await SettlementService.processInflowAndSettle(context, {
                        parentId: updatedItem.parent,
                        amount: originalInput.total || updatedItem.total,
                        paymentMethod: 'CASH',
                        bankRef: updatedItem.code || '',
                        bankDescription: `Thanh toán ngay Hóa đơn ${updatedItem.code || ''}`,
                        settleType: 'SCHOOL_TRANSFER',
                        userId: updatedItem.createdBy || null,
                        note: `Phiếu thu kèm Hóa đơn ${updatedItem.code || ''}`
                    });
                }
            }
        },
        beforeDelete: async ({ context, existingItem }) => {
            // Xoá các Item chi tiết của hoá đơn
            const { data, error } = await context.executeGraphQL({
                context,
                query: gql`
                    query {
                        HoaDon(where: {id: "${existingItem.id}"}){
                            items {
                                id
                            }
                        }
                    }
                `
            });
            if (data?.HoaDon?.items) {
                for (const e of data.HoaDon.items) {
                    await context.executeGraphQL({
                        context,
                        query: gql`
                            mutation {
                                deleteItem (id: "${e.id}"){
                                    id
                                }   
                            }
                        `
                    });
                }
            }
        }
    }
};
