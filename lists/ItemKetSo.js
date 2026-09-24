const { Slug, Text, Checkbox, Relationship, Integer, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');
const SettlementService = require('../func/settlement');

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
        resolveInput: async ({ operation, resolvedData, existingItem, context }) => {
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
            if (operation === "create" && updatedItem.hocsinh && updatedItem.total) {
                const student = await code.getStudent(context, updatedItem.hocsinh);
                if (student && student.parent && student.parent.id) {
                    await SettlementService.processBillCreated(context, {
                        parentId: student.parent.id,
                        amount: updatedItem.total,
                        itemType: 'ItemKetSo',
                        itemId: updatedItem.id,
                        note: `Phát sinh học phí kết sổ ${updatedItem.code || ''}`
                    });
                }
            }
        },
        beforeChange: async ({ operation, resolvedData, existingItem, context }) => {
            if (operation === "update") {
                const reso = JSON.parse(resolvedData.data || '{}');
                // Cập nhật hóa đơn với phiếu kết sổ nếu có
                await code.updateHoaDonWithItemKetSo(context, reso, existingItem);
            }
            return resolvedData;
        },
        beforeDelete: async ({ existingItem, context }) => {
            await code.updateHoaDonWithItemKetSo(context, { hoadons: [] }, existingItem);
        }
    }
};
