const { gql } = require('apollo-server-express');

/**
 * Settlement Engine: Xử lý dòng tiền, số dư ví và gạch nợ hóa đơn có Audit Trail
 */
class SettlementService {
    /**
     * Nạp tiền vào tài khoản Phụ huynh và tự động gạch nợ các hóa đơn chưa thu
     * @param {Object} context - KeystoneJS context
     * @param {Object} params - { parentId, amount, paymentMethod, bankRef, bankDescription, settleType, userId }
     */
    static async processInflowAndSettle(context, params) {
        const {
            parentId,
            amount,
            paymentMethod = 'ACB_BANK',
            bankRef = '',
            bankDescription = '',
            settleType = 'AUTO_ACB',
            userId = null
        } = params;

        const numAmount = parseInt(amount, 10);
        if (isNaN(numAmount) || numAmount <= 0) {
            throw new Error('Số tiền không hợp lệ');
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
            bankDescription,
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

        // Nếu không có parentId (chuyển sai mã, chưa xác định phụ huynh) -> Giữ trạng thái UNALLOCATED
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
        const parentQuery = gql`
            query GetParentDetails($id: ID!) {
                Parent(where: { id: $id }) {
                    id
                    code
                    name
                    debt
                    balance
                }
            }
        `;

        const parentRes = await context.executeGraphQL({
            context,
            query: parentQuery,
            variables: { id: parentId }
        });

        const parent = parentRes.data?.Parent;
        if (!parent) {
            throw new Error(`Không tìm thấy phụ huynh ID: ${parentId}`);
        }

        let currentBalance = (parent.balance || 0) + numAmount;
        let currentDebt = parent.debt || 0;
        let totalSettled = 0;
        const settlements = [];

        // 3. Lấy danh sách các Hóa đơn chưa thanh toán (hoặc các phiếu thu cần gạch nợ)
        // Tìm các HoaDon loại THANHTOAN hoặc NORMAL liên kết với Parent
        const unpaidHoaDonsQuery = gql`
            query GetUnpaidHoaDons($parentId: ID!) {
                allHoaDons(
                    where: { parent: { id: $parentId } }
                    sortBy: createdAt_ASC
                ) {
                    id
                    code
                    total
                    type
                    student {
                        id
                        name
                    }
                }
            }
        `;

        const hoaDonsRes = await context.executeGraphQL({
            context,
            query: unpaidHoaDonsQuery,
            variables: { parentId }
        });

        const hoaDons = hoaDonsRes.data?.allHoaDons || [];

        // Duyệt và cấn trừ cho từng hóa đơn nếu còn số dư ví và còn công nợ
        for (const hd of hoaDons) {
            if (currentBalance <= 0 || currentDebt <= 0) break;

            const hdAmount = hd.total || 0;
            if (hdAmount <= 0) continue;

            // Số tiền gạch nợ cho hóa đơn này
            const settleAmount = Math.min(currentBalance, hdAmount);

            if (settleAmount > 0) {
                // Tạo bản ghi PaymentSettlement (Audit Log)
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

                const settlementInput = {
                    cashTransaction: { connect: { id: cashTx.id } },
                    parent: { connect: { id: parentId } },
                    amount: settleAmount,
                    settleType,
                    status: 'SUCCESS',
                    note: `Gạch nợ cho Hóa đơn ${hd.code || hd.id} (${settleAmount.toLocaleString('vi-VN')} đ)`
                };

                if (hd.id) {
                    settlementInput.hoaDon = { connect: { id: hd.id } };
                }
                if (hd.student?.id) {
                    settlementInput.student = { connect: { id: hd.student.id } };
                }
                if (userId) {
                    settlementInput.settledBy = { connect: { id: userId } };
                }

                const settleRes = await context.executeGraphQL({
                    context,
                    query: createSettlementQuery,
                    variables: { data: settlementInput }
                });

                if (settleRes.data?.createPaymentSettlement) {
                    settlements.push(settleRes.data.createPaymentSettlement);
                    currentBalance -= settleAmount;
                    currentDebt = Math.max(0, currentDebt - settleAmount);
                    totalSettled += settleAmount;
                }
            }
        }

        // 4. Nếu không có hóa đơn cụ thể nhưng parent.debt > 0 -> trừ trực tiếp debt
        if (currentDebt > 0 && currentBalance > 0 && settlements.length === 0) {
            const directSettleAmount = Math.min(currentBalance, currentDebt);
            
            const createDirectSettlementQuery = gql`
                mutation CreateDirectSettlement($data: PaymentSettlementCreateInput!) {
                    createPaymentSettlement(data: $data) {
                        id
                        code
                        amount
                    }
                }
            `;

            const settleRes = await context.executeGraphQL({
                context,
                query: createDirectSettlementQuery,
                variables: {
                    data: {
                        cashTransaction: { connect: { id: cashTx.id } },
                        parent: { connect: { id: parentId } },
                        amount: directSettleAmount,
                        settleType,
                        status: 'SUCCESS',
                        note: `Cấn trừ công nợ tổng hợp (${directSettleAmount.toLocaleString('vi-VN')} đ)`
                    }
                }
            });

            if (settleRes.data?.createPaymentSettlement) {
                settlements.push(settleRes.data.createPaymentSettlement);
                currentBalance -= directSettleAmount;
                currentDebt -= directSettleAmount;
                totalSettled += directSettleAmount;
            }
        }

        // 5. Cập nhật lại số dư ví (balance) và công nợ (debt) của Phụ huynh
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

        // 6. Cập nhật trạng thái của CashTransaction
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
}

module.exports = SettlementService;
