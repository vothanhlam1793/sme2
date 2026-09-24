const { gql } = require('apollo-server-express');

/**
 * Settlement Engine: Xử lý dòng tiền, số dư ví và cấn trừ nợ (Balance & Debt Subledger)
 */
class SettlementService {
    /**
     * Thu tiền (Tiền mặt / Chuyển khoản ACB) -> Tăng balance -> Tự động chạy Settlement gạch nợ nếu đang có debt
     * @param {Object} context - KeystoneJS context
     * @param {Object} params - { parentId, amount, paymentMethod, bankRef, bankDescription, settleType, userId, note }
     */
    static async processInflowAndSettle(context, params) {
        const {
            parentId,
            amount,
            paymentMethod = 'CASH',
            bankRef = '',
            bankDescription = '',
            settleType = 'SCHOOL_TRANSFER',
            userId = null,
            note = ''
        } = params;

        const numAmount = parseInt(amount, 10);
        if (isNaN(numAmount) || numAmount <= 0) {
            throw new Error('Số tiền thu không hợp lệ');
        }

        // 1. Tạo bản ghi Sổ cái Dòng tiền (CashTransaction)
        const createCashTxQuery = gql`
            mutation CreateCashTx($data: CashTransactionCreateInput!) {
                createCashTransaction(data: $data) {
                    id
                    code
                    amount
                    status
                }
            }
        `;

        const cashTxData = {
            type: 'INFLOW',
            amount: numAmount,
            paymentMethod,
            bankRef,
            bankDescription: note || bankDescription || (paymentMethod === 'CASH' ? 'Thu tiền mặt tại quầy' : 'Chuyển khoản'),
            status: 'PENDING'
        };

        if (parentId) {
            cashTxData.parent = { connect: { id: parentId } };
        }
        if (userId) {
            cashTxData.createdBy = { connect: { id: userId } };
        }

        const cashTxRes = await context.executeGraphQL({
            context,
            query: createCashTxQuery,
            variables: { data: cashTxData }
        });

        if (cashTxRes.errors || !cashTxRes.data?.createCashTransaction) {
            throw new Error('Không thể tạo phiếu dòng tiền: ' + JSON.stringify(cashTxRes.errors));
        }

        const cashTx = cashTxRes.data.createCashTransaction;

        if (!parentId) {
            await context.executeGraphQL({
                context,
                query: gql`
                    mutation UpdateCashTxStatus($id: ID!) {
                        updateCashTransaction(id: $id, data: { status: "UNALLOCATED" }) {
                            id
                        }
                    }
                `,
                variables: { id: cashTx.id }
            });

            return {
                success: true,
                cashTransaction: cashTx,
                settledAmount: 0,
                remainingBalance: 0,
                settlements: [],
                message: 'Đã ghi nhận dòng tiền chưa gán Phụ huynh'
            };
        }

        // 2. Lấy thông tin Phụ huynh và công nợ hiện tại
        const parentRes = await context.executeGraphQL({
            context,
            query: gql`
                query GetParentDetails($id: ID!) {
                    Parent(where: { id: $id }) {
                        id
                        code
                        name
                        debt
                        balance
                    }
                }
            `,
            variables: { id: parentId }
        });

        const parent = parentRes.data?.Parent;
        if (!parent) {
            throw new Error(`Không tìm thấy phụ huynh ID: ${parentId}`);
        }

        let currentBalance = (parent.balance || 0) + numAmount;
        let currentDebt = Math.max(0, parent.debt || 0);
        let totalSettled = 0;
        const settlements = [];

        // 3. Nếu có nợ (debt > 0), tự động trích từ balance sang cấn trừ
        if (currentDebt > 0 && currentBalance > 0) {
            const settleAmount = Math.min(currentBalance, currentDebt);

            const createSettlementQuery = gql`
                mutation CreateSettlement($data: PaymentSettlementCreateInput!) {
                    createPaymentSettlement(data: $data) {
                        id
                        code
                        amount
                        settledAt
                    }
                }
            `;

            const settleRes = await context.executeGraphQL({
                context,
                query: createSettlementQuery,
                variables: {
                    data: {
                        cashTransaction: { connect: { id: cashTx.id } },
                        parent: { connect: { id: parentId } },
                        amount: settleAmount,
                        settleType,
                        status: 'SUCCESS',
                        note: note || (paymentMethod === 'CASH' ? 'Trường chuyển cấn trừ từ phiếu thu tiền mặt' : 'Tự động cấn trừ từ nạp tiền')
                    }
                }
            });

            if (settleRes.data?.createPaymentSettlement) {
                settlements.push(settleRes.data.createPaymentSettlement);
                currentBalance -= settleAmount;
                currentDebt -= settleAmount;
                totalSettled += settleAmount;
            }
        }

        // 4. Cập nhật số dư balance và debt của Phụ huynh
        await context.executeGraphQL({
            context,
            query: gql`
                mutation UpdateParentBalanceAndDebt($id: ID!, $balance: Int!, $debt: Int!) {
                    updateParent(id: $id, data: { balance: $balance, debt: $debt }) {
                        id
                        balance
                        debt
                    }
                }
            `,
            variables: {
                id: parentId,
                balance: Math.max(0, currentBalance),
                debt: Math.max(0, currentDebt)
            }
        });

        // 5. Cập nhật trạng thái của CashTransaction
        const finalStatus = totalSettled >= numAmount
            ? 'SETTLED'
            : totalSettled > 0
                ? 'PARTIALLY_SETTLED'
                : 'PENDING';

        await context.executeGraphQL({
            context,
            query: gql`
                mutation UpdateCashTxStatus($id: ID!, $status: String!) {
                    updateCashTransaction(id: $id, data: { status: $status }) {
                        id
                        status
                    }
                }
            `,
            variables: { id: cashTx.id, status: finalStatus }
        });

        return {
            success: true,
            cashTransaction: {
                ...cashTx,
                status: finalStatus
            },
            settledAmount: totalSettled,
            remainingBalance: Math.max(0, currentBalance),
            remainingDebt: Math.max(0, currentDebt),
            settlements
        };
    }

    /**
     * Chi tiền hoàn trả (Outflow) -> Rút từ số dư ví balance của Phụ huynh
     * @param {Object} context - KeystoneJS context
     * @param {Object} params - { parentId, amount, paymentMethod, reason, userId }
     */
    static async processOutflow(context, params) {
        const {
            parentId,
            amount,
            paymentMethod = 'CASH',
            reason = '',
            userId = null
        } = params;

        const numAmount = parseInt(amount, 10);
        if (isNaN(numAmount) || numAmount <= 0) {
            throw new Error('Số tiền chi hoàn trả không hợp lệ');
        }

        // 1. Kiểm tra thông tin phụ huynh
        const parentRes = await context.executeGraphQL({
            context,
            query: gql`
                query GetParentDetails($id: ID!) {
                    Parent(where: { id: $id }) {
                        id
                        code
                        name
                        balance
                    }
                }
            `,
            variables: { id: parentId }
        });

        const parent = parentRes.data?.Parent;
        if (!parent) {
            throw new Error(`Không tìm thấy phụ huynh ID: ${parentId}`);
        }

        const currentBalance = parent.balance || 0;
        if (currentBalance < numAmount) {
            throw new Error(`Số dư ví (${currentBalance.toLocaleString('vi-VN')} đ) không đủ để chi hoàn trả ${numAmount.toLocaleString('vi-VN')} đ`);
        }

        // 2. Tạo bản ghi Phiếu Chi (CashTransaction OUTFLOW)
        const createCashTxQuery = gql`
            mutation CreateCashTx($data: CashTransactionCreateInput!) {
                createCashTransaction(data: $data) {
                    id
                    code
                    amount
                    status
                }
            }
        `;

        const cashTxData = {
            type: 'OUTFLOW',
            amount: numAmount,
            paymentMethod,
            bankDescription: reason || 'Chi tiền hoàn trả phụ huynh',
            status: 'SETTLED'
        };

        if (parentId) {
            cashTxData.parent = { connect: { id: parentId } };
        }
        if (userId) {
            cashTxData.createdBy = { connect: { id: userId } };
        }

        const cashTxRes = await context.executeGraphQL({
            context,
            query: createCashTxQuery,
            variables: { data: cashTxData }
        });

        if (cashTxRes.errors || !cashTxRes.data?.createCashTransaction) {
            throw new Error('Không thể tạo phiếu chi: ' + JSON.stringify(cashTxRes.errors));
        }

        // 3. Trừ balance của Phụ huynh
        const newBalance = currentBalance - numAmount;
        await context.executeGraphQL({
            context,
            query: gql`
                mutation UpdateParentBalance($id: ID!, $balance: Int!) {
                    updateParent(id: $id, data: { balance: $balance }) {
                        id
                        balance
                    }
                }
            `,
            variables: { id: parentId, balance: newBalance }
        });

        return {
            success: true,
            cashTransaction: cashTxRes.data.createCashTransaction,
            newBalance
        };
    }

    /**
     * Nghiệp vụ Cấn trừ nợ chủ động từ Balance sang Debt (Thao tác chuyển tiền)
     * @param {Object} context - KeystoneJS context
     * @param {Object} params - { parentId, amount, settleType, note, userId }
     */
    static async transferBalanceToDebt(context, params) {
        const {
            parentId,
            amount = null, // null nghĩa là cấn trừ tối đa
            settleType = 'SCHOOL_TRANSFER', // 'SCHOOL_TRANSFER' | 'PARENT_TRANSFER' | 'MANUAL_ACCOUNTANT'
            note = '',
            userId = null
        } = params;

        const parentRes = await context.executeGraphQL({
            context,
            query: gql`
                query GetParentDetails($id: ID!) {
                    Parent(where: { id: $id }) {
                        id
                        code
                        name
                        debt
                        balance
                    }
                }
            `,
            variables: { id: parentId }
        });

        const parent = parentRes.data?.Parent;
        if (!parent) {
            throw new Error(`Không tìm thấy phụ huynh ID: ${parentId}`);
        }

        let balance = parent.balance || 0;
        let debt = parent.debt || 0;

        if (balance <= 0) {
            throw new Error('Số dư ví bằng 0, không thể thực hiện cấn trừ');
        }
        if (debt <= 0) {
            throw new Error('Phụ huynh không có nợ để cấn trừ');
        }

        let settleAmount = amount ? parseInt(amount, 10) : Math.min(balance, debt);
        settleAmount = Math.min(settleAmount, balance, debt);

        if (settleAmount <= 0) {
            throw new Error('Số tiền cấn trừ không hợp lệ');
        }

        // Tạo bản ghi Settlement
        const createSettlementQuery = gql`
            mutation CreateSettlement($data: PaymentSettlementCreateInput!) {
                createPaymentSettlement(data: $data) {
                    id
                    code
                    amount
                    settledAt
                    settleType
                }
            }
        `;

        const settleRes = await context.executeGraphQL({
            context,
            query: createSettlementQuery,
            variables: {
                data: {
                    parent: { connect: { id: parentId } },
                    amount: settleAmount,
                    settleType,
                    status: 'SUCCESS',
                    note: note || (settleType === 'PARENT_TRANSFER' ? 'Phụ huynh chuyển cấn trừ nợ' : 'Trường chuyển cấn trừ từ số dư ví')
                }
            }
        });

        if (settleRes.errors || !settleRes.data?.createPaymentSettlement) {
            throw new Error('Lỗi khi tạo chứng từ cấn trừ: ' + JSON.stringify(settleRes.errors));
        }

        // Cập nhật Parent
        const newBalance = balance - settleAmount;
        const newDebt = debt - settleAmount;

        await context.executeGraphQL({
            context,
            query: gql`
                mutation UpdateParentBalanceAndDebt($id: ID!, $balance: Int!, $debt: Int!) {
                    updateParent(id: $id, data: { balance: $balance, debt: $debt }) {
                        id
                        balance
                        debt
                    }
                }
            `,
            variables: {
                id: parentId,
                balance: Math.max(0, newBalance),
                debt: Math.max(0, newDebt)
            }
        });

        return {
            success: true,
            settlement: settleRes.data.createPaymentSettlement,
            settledAmount: settleAmount,
            remainingBalance: newBalance,
            remainingDebt: newDebt
        };
    }

    /**
     * Xử lý phát sinh nợ khi xuất Hóa đơn / Kết sổ tháng -> Tăng debt -> Tự cấn trừ nếu có sẵn balance
     * @param {Object} context - KeystoneJS context
     * @param {Object} params - { parentId, amount, itemType, itemId, note }
     */
    static async processBillCreated(context, params) {
        const { parentId, amount, itemType = 'ItemKetSo', itemId = null, note = '' } = params;
        const numAmount = parseInt(amount, 10);
        if (isNaN(numAmount) || numAmount <= 0) return;

        const parentRes = await context.executeGraphQL({
            context,
            query: gql`
                query GetParentDetails($id: ID!) {
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
        if (!parent) return;

        let currentDebt = (parent.debt || 0) + numAmount;
        let currentBalance = parent.balance || 0;
        let settledAmount = 0;

        // Nếu có sẵn tiền trong ví -> Tự động cấn trừ ngay lập tức
        if (currentBalance > 0) {
            settledAmount = Math.min(currentBalance, currentDebt);

            await context.executeGraphQL({
                context,
                query: gql`
                    mutation CreateSettlement($data: PaymentSettlementCreateInput!) {
                        createPaymentSettlement(data: $data) {
                            id
                        }
                    }
                `,
                variables: {
                    data: {
                        parent: { connect: { id: parentId } },
                        amount: settledAmount,
                        settleType: 'AUTO_ACB',
                        status: 'SUCCESS',
                        note: note || `Tự động cấn trừ từ số dư khả dụng khi phát sinh ${itemType}`
                    }
                }
            });

            currentBalance -= settledAmount;
            currentDebt -= settledAmount;
        }

        // Cập nhật Parent
        await context.executeGraphQL({
            context,
            query: gql`
                mutation UpdateParentBalanceAndDebt($id: ID!, $balance: Int!, $debt: Int!) {
                    updateParent(id: $id, data: { balance: $balance, debt: $debt }) {
                        id
                    }
                }
            `,
            variables: {
                id: parentId,
                balance: Math.max(0, currentBalance),
                debt: Math.max(0, currentDebt)
            }
        });
    }
}

module.exports = SettlementService;
