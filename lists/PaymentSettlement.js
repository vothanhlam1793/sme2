const { Text, Select, Integer, Relationship, DateTime } = require('@keystonejs/fields');
const { gql } = require('apollo-server-express');
const code = require('../func/code');
const SettlementService = require('../func/settlement');
const executeAccounting = require('../func/accountingGraphQL');

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
                { value: 'SCHOOL_TRANSFER', label: 'Trường chuyển cấn trừ' },
                { value: 'PARENT_TRANSFER', label: 'Phụ huynh chuyển cấn trừ' },
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
        },
        afterChange: async ({ operation, updatedItem, existingItem, context }) => {
            if (operation === 'create' && updatedItem.parent && updatedItem.amount && updatedItem.status === 'SUCCESS') {
                try {
                    const parentId = String(updatedItem.parent.id || updatedItem.parent._id || updatedItem.parent);
                    const settlementId = String(updatedItem.id || updatedItem._id || '');
                    const parentRes = await executeAccounting(context, {
                        context,
                        query: gql`
                            query GetParent($id: ID!) {
                                Parent(where: { id: $id }) {
                                    id
                                    debt
                                    balance
                                }
                            }
                        `,
                        variables: { id: parentId }
                    });

                    const parent = parentRes.data?.Parent;
                    if (parent) {
                        const curDebt = parent.debt || 0;
                        const curBal = parent.balance || 0;
                        const settleAmount = parseInt(updatedItem.amount, 10) || 0;

                        const newDebt = Math.max(0, curDebt - settleAmount);
                        const newBal = Math.max(0, curBal - settleAmount);

                        await executeAccounting(context, {
                            context,
                            query: gql`
                                mutation UpdateParentFinances($id: ID!, $debt: Int!, $balance: Int!) {
                                    updateParent(id: $id, data: { debt: $debt, balance: $balance }) {
                                        id
                                        debt
                                        balance
                                    }
                                }
                            `,
                            variables: {
                                id: parent.id,
                                debt: newDebt,
                                balance: newBal
                            }
                        });

                        // Ghi vết audit log nhẹ để quản trị đối soát khi cần
                        await SettlementService.writeDebtLog(context, {
                            parentId: parent.id,
                            change: -settleAmount,
                            newDebt,
                            itemS: 'PaymentSettlement',
                            idItemS: settlementId,
                            type: 'DOWN'
                        });
                    }
                } catch (e) {
                    throw e;
                }
            }
        }
    }
};
