const { Text, Select, Integer, Relationship, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');

module.exports = {
    fields: {
        code: {
            type: Text,
            isUnique: true
        },
        type: {
            type: Select,
            options: [
                { value: 'INFLOW', label: 'Tiền vào' },
                { value: 'OUTFLOW', label: 'Tiền ra / Hoàn tiền' }
            ],
            defaultValue: 'INFLOW',
            isRequired: true
        },
        amount: {
            type: Integer,
            isRequired: true
        },
        paymentMethod: {
            type: Select,
            options: [
                { value: 'ACB_BANK', label: 'Chuyển khoản ACB' },
                { value: 'CASH', label: 'Tiền mặt' },
                { value: 'OTHER', label: 'Khác' }
            ],
            defaultValue: 'ACB_BANK'
        },
        parent: {
            type: Relationship,
            ref: 'Parent',
            many: false,
            isIndexed: true
        },
        bankRef: {
            type: Text
        },
        bankDescription: {
            type: Text
        },
        status: {
            type: Select,
            options: [
                { value: 'PENDING', label: 'Chờ xử lý' },
                { value: 'SETTLED', label: 'Đã gạch nợ' },
                { value: 'PARTIALLY_SETTLED', label: 'Gạch nợ một phần' },
                { value: 'UNALLOCATED', label: 'Chưa gán Phụ huynh' },
                { value: 'CANCELLED', label: 'Đã hủy' }
            ],
            defaultValue: 'PENDING'
        },
        settlements: {
            type: Relationship,
            ref: 'PaymentSettlement.cashTransaction',
            many: true
        },
        createdAt: {
            type: DateTime
        },
        createdBy: {
            type: Relationship,
            ref: 'User',
            many: false
        }
    },
    access: {
        auth: true
    },
    hooks: {
        validateInput: async ({ operation, resolvedData, context }) => {
            if (operation === 'create') {
                if (!resolvedData.code) {
                    resolvedData.code = await code.getCode(context, 'CT');
                }
                if (!resolvedData.createdAt) {
                    resolvedData.createdAt = new Date().toISOString();
                }
            }
            const user = context.authedItem;
            if (user && operation === 'create' && !resolvedData.createdBy) {
                resolvedData.createdBy = user.id;
            }
            return resolvedData;
        }
    }
};
