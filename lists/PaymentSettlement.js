const { Text, Select, Integer, Relationship, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');

module.exports = {
    fields: {
        code: {
            type: Text,
            isUnique: true
        },
        cashTransaction: {
            type: Relationship,
            ref: 'CashTransaction.settlements',
            many: false,
            isRequired: false
        },
        parent: {
            type: Relationship,
            ref: 'Parent',
            many: false,
            isRequired: true,
            isIndexed: true
        },
        student: {
            type: Relationship,
            ref: 'Student',
            many: false
        },
        hoaDon: {
            type: Relationship,
            ref: 'HoaDon',
            many: false
        },
        phieuKetSo: {
            type: Relationship,
            ref: 'PhieuKetSo',
            many: false
        },
        amount: {
            type: Integer,
            isRequired: true
        },
        settleType: {
            type: Select,
            options: [
                { value: 'AUTO_ACB', label: 'Tự động từ ACB' },
                { value: 'MANUAL_ACCOUNTANT', label: 'Kế toán gạch nợ' },
                { value: 'WALLET_DEDUCT', label: 'Trừ số dư ví' }
            ],
            defaultValue: 'AUTO_ACB'
        },
        status: {
            type: Select,
            options: [
                { value: 'SUCCESS', label: 'Thành công' },
                { value: 'REVERTED', label: 'Đã hoàn tác' }
            ],
            defaultValue: 'SUCCESS'
        },
        note: {
            type: Text
        },
        settledAt: {
            type: DateTime
        },
        settledBy: {
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
                    resolvedData.code = await code.getCode(context, 'STL');
                }
                if (!resolvedData.settledAt) {
                    resolvedData.settledAt = new Date().toISOString();
                }
            }
            const user = context.authedItem;
            if (user && operation === 'create' && !resolvedData.settledBy) {
                resolvedData.settledBy = user.id;
            }
            return resolvedData;
        }
    }
};
