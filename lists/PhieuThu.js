const { Slug, Text, Checkbox, Relationship, Integer, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');
const SettlementService = require('../func/settlement');

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
    access: {
        auth: true,
    },
    hooks: {
        validateInput: async ({ operation, resolvedData, context }) => {
            if (operation === "create") {
                if (!resolvedData.code) {
                    resolvedData.code = await code.getCode(context, "PTT");
                }
                if (!resolvedData.createdAt) {
                    resolvedData.createdAt = (new Date()).toISOString();
                }
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
        afterChange: async ({ operation, updatedItem, context }) => {
            // Khi tạo Phiếu Thu tiền mặt -> Nạp vào balance và tự động kích hoạt Settlement cấn trừ debt
            if (operation === "create" && updatedItem.parent && updatedItem.total) {
                try {
                    const totalNum = parseInt(updatedItem.total, 10);
                    if (totalNum > 0) {
                        await SettlementService.processInflowAndSettle(context, {
                            parentId: updatedItem.parent,
                            amount: totalNum,
                            paymentMethod: 'CASH',
                            bankRef: updatedItem.code || '',
                            bankDescription: updatedItem.ghichu || 'Thu tiền mặt tại quầy',
                            settleType: 'SCHOOL_TRANSFER',
                            userId: updatedItem.createdBy || null,
                            note: updatedItem.ghichu || `Phiếu thu tiền mặt ${updatedItem.code || ''}`
                        });
                    } else if (totalNum < 0) {
                        // Số tiền âm -> Phiếu Chi / Hoàn trả
                        await SettlementService.processOutflow(context, {
                            parentId: updatedItem.parent,
                            amount: Math.abs(totalNum),
                            paymentMethod: 'CASH',
                            reason: updatedItem.ghichu || `Hoàn trả tiền theo phiếu ${updatedItem.code || ''}`,
                            userId: updatedItem.createdBy || null
                        });
                    }
                } catch (err) {
                    console.error('Lỗi sau khi tạo PhieuThu trong SettlementService:', err);
                }
            }
        }
    }
};
