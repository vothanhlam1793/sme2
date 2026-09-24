const express = require('express');
const { gql } = require('apollo-server-express');
const SettlementService = require('../func/settlement');

function createParentPortalRouter(keystone) {
    const router = express.Router();
    router.use(express.json());

    // Cấu hình ngân hàng VietQR ACB
    const BANK_CONFIG = {
        bankCode: process.env.VIETQR_BANK_CODE || 'ACB',
        accountNo: process.env.VIETQR_ACCOUNT_NO || '77229966',
        accountName: process.env.VIETQR_ACCOUNT_NAME || 'TRUONG MAM NON NGOC HOANG'
    };

    /**
     * Middleware kiểm tra API Key bảo mật (Server-to-Server)
     */
    const authenticatePortal = (req, res, next) => {
        const portalKey = req.headers['x-portal-token'] || req.query.portal_token;
        const validKey = process.env.PARENT_PORTAL_SECRET || 'camerangochoang_portal_secret_2026';
        
        if (portalKey && portalKey === validKey) {
            return next();
        }
        return res.status(401).json({
            success: false,
            message: 'Unauthorized: Invalid or missing portal token'
        });
    };

    /**
     * API 1: Tra cứu tổng hợp thông tin Phụ huynh, Học sinh, Học phí, VietQR, Thông báo
     * POST /api/portal/parent-summary
     * Body: { phone: "0912345678" }
     */
    router.post('/parent-summary', authenticatePortal, async (req, res) => {
        try {
            const rawPhone = (req.body.phone || '').trim();
            if (!rawPhone) {
                return res.status(400).json({ success: false, message: 'Vui lòng cung cấp số điện thoại' });
            }

            // Chuẩn hóa số điện thoại: bỏ khoảng trắng, dấu gạch ngang, 84 -> 0
            let cleanPhone = rawPhone.replace(/\D/g, '');
            if (cleanPhone.startsWith('84')) {
                cleanPhone = '0' + cleanPhone.substring(2);
            }

            const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });

            // Tìm Phone record liên kết với Parent
            const findPhoneQuery = gql`
                query FindParentByPhone($number: String!) {
                    allPhones(where: { number: $number }) {
                        id
                        number
                        name
                        parent {
                            id
                            code
                            name
                            debt
                            balance
                            hocsinhs {
                                id
                                name
                                status
                                lophoc {
                                    id
                                    name
                                }
                            }
                        }
                    }
                }
            `;

            const phoneRes = await context.executeGraphQL({
                context,
                query: findPhoneQuery,
                variables: { number: cleanPhone }
            });

            const phoneRecord = phoneRes.data?.allPhones?.[0];
            if (!phoneRecord || !phoneRecord.parent) {
                return res.status(404).json({
                    success: false,
                    message: 'Không tìm thấy dữ liệu học sinh với số điện thoại này'
                });
            }

            const parent = phoneRecord.parent;
            const students = (parent.hocsinhs || []).map(s => ({
                id: s.id,
                name: s.name,
                status: s.status,
                className: s.lophoc?.name || 'Chưa xếp lớp',
                classId: s.lophoc?.id || null
            }));

            // Lấy danh sách ID các lớp của con để query thông báo phù hợp
            const classIds = students.map(s => s.classId).filter(Boolean);

            // 1. Lấy thông tin Thông báo (Toàn trường + Các lớp của bé)
            const notifQuery = gql`
                query GetNotifications {
                    allNotifications(
                        where: { status: "PUBLISHED" }
                        sortBy: publishedAt_DESC
                        first: 10
                    ) {
                        id
                        code
                        title
                        content
                        scope
                        publishedAt
                        classes {
                            id
                            name
                        }
                    }
                }
            `;

            const notifRes = await context.executeGraphQL({ context, query: notifQuery });
            const allNotifs = notifRes.data?.allNotifications || [];

            // Lọc thông báo toàn trường hoặc đúng lớp
            const relevantNotifs = allNotifs.filter(n => {
                if (n.scope === 'ALL_SCHOOL') return true;
                if (n.scope === 'CLASS' && n.classes?.length > 0) {
                    return n.classes.some(c => classIds.includes(c.id));
                }
                return false;
            }).map(n => ({
                id: n.id,
                code: n.code,
                title: n.title,
                content: n.content,
                publishedAt: n.publishedAt
            }));

            // 2. Lấy kỳ kết sổ / hóa đơn mới nhất của phụ huynh
            const hoaDonsQuery = gql`
                query GetParentInvoices($parentId: ID!) {
                    allHoaDons(
                        where: { parent: { id: $parentId } }
                        sortBy: createdAt_DESC
                        first: 5
                    ) {
                        id
                        code
                        total
                        type
                        createdAt
                        student {
                            name
                        }
                        items {
                            name
                            total
                            quantity
                        }
                    }
                }
            `;

            const invoicesRes = await context.executeGraphQL({
                context,
                query: hoaDonsQuery,
                variables: { parentId: parent.id }
            });

            const invoices = invoicesRes.data?.allHoaDons || [];
            const latestInvoice = invoices[0] || null;

            // 3. Lấy lịch sử gạch nợ / thanh toán (PaymentSettlement)
            const settlementsQuery = gql`
                query GetSettlements($parentId: ID!) {
                    allPaymentSettlements(
                        where: { parent: { id: $parentId }, status: "SUCCESS" }
                        sortBy: settledAt_DESC
                        first: 5
                    ) {
                        id
                        code
                        amount
                        settledAt
                        settleType
                        note
                    }
                }
            `;

            const settlementsRes = await context.executeGraphQL({
                context,
                query: settlementsQuery,
                variables: { parentId: parent.id }
            });

            const paymentHistory = (settlementsRes.data?.allPaymentSettlements || []).map(st => ({
                code: st.code,
                amount: st.amount,
                settledAt: st.settledAt,
                method: st.settleType === 'AUTO_ACB' ? 'Chuyển khoản ACB' : 'Thanh toán trực tiếp',
                note: st.note
            }));

            // 4. Tạo mã VietQR chuẩn hóa
            const amountToPay = Math.max(0, parent.debt || 0);
            const parentCode = parent.code || `PH${parent.id}`;
            const qrContent = parentCode.toUpperCase(); // Nội dung chuyển khoản bắt buộc là Mã Phụ huynh
            
            let vietqrUrl = `https://img.vietqr.io/image/${BANK_CONFIG.bankCode}-${BANK_CONFIG.accountNo}-print.png`;
            vietqrUrl += `?accountName=${encodeURIComponent(BANK_CONFIG.accountName)}`;
            vietqrUrl += `&addInfo=${encodeURIComponent(qrContent)}`;
            if (amountToPay > 0) {
                vietqrUrl += `&amount=${amountToPay}`;
            }

            return res.json({
                success: true,
                data: {
                    parent: {
                        id: parent.id,
                        code: parent.code,
                        name: parent.name,
                        phone: cleanPhone,
                        debt: parent.debt || 0,
                        balance: parent.balance || 0,
                        isPaid: (parent.debt || 0) <= 0
                    },
                    students,
                    vietqr: {
                        bankName: BANK_CONFIG.bankCode,
                        accountNo: BANK_CONFIG.accountNo,
                        accountName: BANK_CONFIG.accountName,
                        transferContent: qrContent,
                        amount: amountToPay,
                        qrImageUrl: vietqrUrl
                    },
                    latestInvoice: latestInvoice ? {
                        id: latestInvoice.id,
                        code: latestInvoice.code,
                        total: latestInvoice.total,
                        studentName: latestInvoice.student?.name || '',
                        createdAt: latestInvoice.createdAt,
                        items: latestInvoice.items || []
                    } : null,
                    notifications: relevantNotifs,
                    paymentHistory
                }
            });

        } catch (error) {
            console.error('[ParentPortal API Error]:', error);
            return res.status(500).json({
                success: false,
                message: 'Lỗi máy chủ khi tra cứu thông tin phụ huynh',
                error: error.message
            });
        }
    });

    /**
     * API 2: Webhook tiếp nhận biến động số dư ACB / Dòng tiền
     * POST /api/portal/acb-webhook
     */
    router.post('/acb-webhook', authenticatePortal, async (req, res) => {
        try {
            const { amount, description, bankRef } = req.body;
            const numAmount = parseInt(amount, 10);

            if (isNaN(numAmount) || numAmount <= 0) {
                return res.status(400).json({ success: false, message: 'Số tiền giao dịch không hợp lệ' });
            }

            const rawDesc = description || '';
            const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });

            // Tìm mã phụ huynh PHxxxxxx trong nội dung chuyển khoản
            const match = rawDesc.match(/PH\d{4,8}/i);
            let parentId = null;

            if (match) {
                const parentCode = match[0].toUpperCase();
                const parentQuery = gql`
                    query FindParentByCode($code: String!) {
                        allParents(where: { code: $code }) {
                            id
                            code
                            name
                        }
                    }
                `;

                const pRes = await context.executeGraphQL({
                    context,
                    query: parentQuery,
                    variables: { code: parentCode }
                });

                parentId = pRes.data?.allParents?.[0]?.id || null;
            }

            // Gọi SettlementService để xử lý dòng tiền và tự động gạch nợ
            const settleResult = await SettlementService.processInflowAndSettle(context, {
                parentId,
                amount: numAmount,
                paymentMethod: 'ACB_BANK',
                bankRef: bankRef || '',
                bankDescription: rawDesc,
                settleType: 'AUTO_ACB'
            });

            return res.json({
                success: true,
                message: parentId ? 'Đã nhận dòng tiền và tự động gạch nợ thành công' : 'Đã lưu dòng tiền (chờ kế toán gán Phụ huynh)',
                data: settleResult
            });

        } catch (error) {
            console.error('[ACB Webhook Error]:', error);
            return res.status(500).json({
                success: false,
                message: 'Lỗi khi xử lý biến động số dư',
                error: error.message
            });
        }
    });

    return router;
}

module.exports = createParentPortalRouter;
