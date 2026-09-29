const express = require('express');
const { gql } = require('apollo-server-express');
const SettlementService = require('../func/settlement');

// GraphQL can resolve with errors (including partial data) instead of rejecting.
// Check before treating an empty lookup as not found or attempting a write.
function checkGraphQLResult(result, field) {
    if (result?.errors?.length) {
        throw new Error(`GraphQL operation failed: ${field}`);
    }
    if (result?.data?.[field] == null) {
        throw new Error(`Missing GraphQL result: ${field}`);
    }
    return result.data;
}

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
                                birthday
                                luuy
                                hocphigiam
                                lophoc {
                                    id
                                    name
                                    chunhiem {
                                        id
                                        name
                                        phone
                                    }
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

            checkGraphQLResult(phoneRes, 'allPhones');
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
                birthday: s.birthday || null,
                status: s.status || null,
                note: s.luuy || '',
                tuitionDiscount: s.hocphigiam || '0',
                className: s.lophoc?.name || 'Chưa xếp lớp',
                classId: s.lophoc?.id || null,
                teachers: (s.lophoc?.chunhiem || []).map(t => ({
                    id: t.id,
                    name: t.name,
                    phone: t.phone || ''
                }))
            }));

            // Lấy danh sách ID các lớp của con để query thông báo phù hợp
            const classIds = students.map(s => s.classId).filter(Boolean);

            // 1. Lấy thông tin Thông báo (Toàn trường + Các lớp của bé)
            const notifQuery = gql`
                query GetNotifications {
                    allNotifications(
                        where: { status: PUBLISHED }
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
            checkGraphQLResult(notifRes, 'allNotifications');
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
            const studentIds = students.map(s => s.id).filter(Boolean);
            const hoaDonsQuery = gql`
                query GetParentInvoices($parentId: ID!, $studentIds: [ID!]) {
                    allHoaDons(
                        where: { parent: { id: $parentId } }
                        sortBy: createdAt_DESC
                        first: 10
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
                    allItemKetSos(
                        where: { hocsinh: { id_in: $studentIds } }
                        sortBy: createdAt_DESC
                        first: 10
                    ) {
                        id
                        code
                        data
                        total
                        createdAt
                        hocsinh {
                            name
                        }
                        phieuketso {
                            code
                        }
                        lophoc {
                            name
                        }
                    }
                }
            `;

            const invoicesRes = await context.executeGraphQL({
                context,
                query: hoaDonsQuery,
                variables: { parentId: parent.id, studentIds }
            });

            checkGraphQLResult(invoicesRes, 'allHoaDons');
            checkGraphQLResult(invoicesRes, 'allItemKetSos');

            const rawHoaDons = (invoicesRes.data?.allHoaDons || []).map(inv => {
                const invCode = inv.code || `HD${inv.id}`;
                let invQr = `https://img.vietqr.io/image/${BANK_CONFIG.bankCode}-${BANK_CONFIG.accountNo}-compact2.png`;
                invQr += `?accountName=${encodeURIComponent(BANK_CONFIG.accountName)}`;
                invQr += `&addInfo=${encodeURIComponent(invCode.toUpperCase())}`;
                if ((inv.total || 0) > 0) invQr += `&amount=${inv.total}`;

                return {
                    id: inv.id,
                    code: inv.code,
                    total: inv.total,
                    studentName: inv.student?.name || '',
                    createdAt: inv.createdAt,
                    type: 'HOA_DON',
                    vietqrUrl: invQr,
                    items: inv.items || []
                };
            });

            const rawItemKetSos = (invoicesRes.data?.allItemKetSos || []).map(iks => {
                let dataObj = {};
                try {
                    if (iks.data) dataObj = JSON.parse(iks.data);
                } catch (_) {}

                const total = dataObj.total || iks.total || 0;
                const items = [];
                if (dataObj.hocphi) items.push({ name: 'Học phí', total: dataObj.hocphi, quantity: 1 });
                if (dataObj.csvc) items.push({ name: 'Cơ sở vật chất', total: dataObj.csvc, quantity: 1 });
                if (dataObj.camera) items.push({ name: 'Tiền camera', total: dataObj.camera, quantity: 1 });
                if (dataObj.an545) items.push({ name: 'Tiền ăn chiều', total: dataObj.an545, quantity: 1 });
                if (dataObj.ngoaigio) items.push({ name: 'Tiền ngoài giờ', total: dataObj.ngoaigio, quantity: 1 });
                if (dataObj.khac) items.push({ name: 'Khoản thu khác', total: dataObj.khac, quantity: 1 });
                if (dataObj.thanhtiennghi) items.push({ name: `Trừ tiền ngày nghỉ (${dataObj.ngaynghi || 0} ngày)`, total: -Math.abs(dataObj.thanhtiennghi), quantity: dataObj.ngaynghi || 1 });

                const pksCode = iks.phieuketso?.code || '';
                const codeDisplay = iks.code || (pksCode ? `KS_${pksCode}` : `KS${iks.id}`);
                const monthDisplay = pksCode ? pksCode.replace('_', '/') : '';

                let fallbackDate = iks.createdAt;
                if (!fallbackDate && pksCode && /^\d{4}_\d{2}$/.test(pksCode)) {
                    const [y, m] = pksCode.split('_');
                    fallbackDate = `${y}-${m}-01T00:00:00.000Z`;
                }

                let ksQr = `https://img.vietqr.io/image/${BANK_CONFIG.bankCode}-${BANK_CONFIG.accountNo}-compact2.png`;
                ksQr += `?accountName=${encodeURIComponent(BANK_CONFIG.accountName)}`;
                ksQr += `&addInfo=${encodeURIComponent(codeDisplay.toUpperCase())}`;
                if (total > 0) ksQr += `&amount=${total}`;

                return {
                    id: iks.id,
                    code: codeDisplay,
                    total: total,
                    studentName: iks.hocsinh?.name || '',
                    createdAt: fallbackDate,
                    type: 'KET_SO',
                    month: monthDisplay,
                    vietqrUrl: ksQr,
                    items: items
                };
            });

            // Gộp Hóa đơn và Phiếu kết sổ, sắp xếp theo thời gian mới nhất
            const formattedInvoices = [...rawHoaDons, ...rawItemKetSos].sort((a, b) => {
                const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                return tB - tA;
            });
            const latestInvoice = formattedInvoices[0] || null;

            // 3. Lấy lịch sử thu tiền / gạch nợ / thanh toán (PaymentSettlement + PhieuThu)
            const settlementsQuery = gql`
                query GetSettlements($parentId: ID!) {
                    allPaymentSettlements(
                        where: { parent: { id: $parentId }, status: SUCCESS }
                        sortBy: settledAt_DESC
                        first: 10
                    ) {
                        id
                        code
                        amount
                        settledAt
                        settleType
                        note
                    }
                    allPhieuThus(
                        where: { parent: { id: $parentId } }
                        sortBy: createdAt_DESC
                        first: 10
                    ) {
                        id
                        code
                        total
                        createdAt
                        ghichu
                        itemThu
                    }
                }
            `;

            const settlementsRes = await context.executeGraphQL({
                context,
                query: settlementsQuery,
                variables: { parentId: parent.id }
            });

            checkGraphQLResult(settlementsRes, 'allPaymentSettlements');
            checkGraphQLResult(settlementsRes, 'allPhieuThus');
            
            const rawSettlements = (settlementsRes.data?.allPaymentSettlements || []).map(st => ({
                id: st.id,
                code: st.code,
                amount: st.amount,
                settledAt: st.settledAt,
                method: st.settleType === 'AUTO_ACB' ? 'Chuyển khoản ACB' : 'Thanh toán trực tiếp',
                note: st.note
            }));

            const rawPhieuThus = (settlementsRes.data?.allPhieuThus || []).map(pt => ({
                id: pt.id,
                code: pt.code,
                amount: pt.total,
                settledAt: pt.createdAt,
                method: 'Thu tiền trực tiếp',
                note: pt.ghichu || pt.itemThu || 'Phiếu thu học phí'
            }));

            // Hợp nhất và sắp xếp giảm dần theo thời gian
            const paymentHistory = [...rawSettlements, ...rawPhieuThus].sort((a, b) => {
                const tA = a.settledAt ? new Date(a.settledAt).getTime() : 0;
                const tB = b.settledAt ? new Date(b.settledAt).getTime() : 0;
                return tB - tA;
            });

            // 4. Tạo mã VietQR chuẩn hóa
            const amountToPay = Math.max(0, parent.debt || 0);
            const parentCode = parent.code || `PH${parent.id}`;
            const qrContent = parentCode.toUpperCase(); // Nội dung chuyển khoản bắt buộc là Mã Phụ huynh
            
            let vietqrUrl = `https://img.vietqr.io/image/${BANK_CONFIG.bankCode}-${BANK_CONFIG.accountNo}-compact2.png`;
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
                    latestInvoice: formattedInvoices[0] || null,
                    invoices: formattedInvoices,
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

                checkGraphQLResult(pRes, 'allParents');
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

    /**
     * API 3: Quản lý Cấu hình Portal API Key (Dành cho Super Admin)
     * GET /api/portal/config
     */
    router.get('/config', async (req, res) => {
        try {
            const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });
            const wsHub = require('./wsHub');
            const config = await wsHub.getPortalConfig(context);
            const stats = wsHub.getStats();

            return res.json({
                success: true,
                data: {
                    ...config,
                    ws_url: `wss://${req.get('host')}/ws/parent`,
                    active_connections: stats.totalConnections,
                    active_parents: stats.activeParents
                }
            });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * API 4: Cập nhật Cấu hình Portal API Key (Dành cho Super Admin)
     * POST /api/portal/config
     */
    router.post('/config', async (req, res) => {
        try {
            const newConfig = req.body;
            const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });

            const existingRes = await context.executeGraphQL({
                context,
                query: gql`
                    query {
                        allSystemSettings(where: { key: "PORTAL_GATEWAY_CONFIG" }) {
                            id
                        }
                    }
                `
            });

            const existing = checkGraphQLResult(existingRes, 'allSystemSettings');
            const jsonStr = JSON.stringify(newConfig);

            if (existing?.allSystemSettings?.length > 0) {
                const updateRes = await context.executeGraphQL({
                    context,
                    query: gql`
                        mutation ($id: ID!, $value: String!) {
                            updateSystemSetting(id: $id, data: { value: $value }) {
                                id
                            }
                        }
                    `,
                    variables: { id: existing.allSystemSettings[0].id, value: jsonStr }
                });
                checkGraphQLResult(updateRes, 'updateSystemSetting');
            } else {
                const createRes = await context.executeGraphQL({
                    context,
                    query: gql`
                        mutation ($key: String!, $value: String!) {
                            createSystemSetting(data: { key: $key, value: $value, isSecret: true, description: "Cấu hình cổng kết nối App Phụ Huynh camerangochoang.com" }) {
                                id
                            }
                        }
                    `,
                    variables: { key: 'PORTAL_GATEWAY_CONFIG', value: jsonStr }
                });
                checkGraphQLResult(createRes, 'createSystemSetting');
            }

            return res.json({ success: true, message: 'Đã lưu cấu hình Cổng Phụ Huynh thành công' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = createParentPortalRouter;
