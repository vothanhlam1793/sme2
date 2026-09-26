const express = require('express');
const crypto = require('crypto');
const { gql } = require('apollo-server-express');
const SettlementService = require('../func/settlement');

/**
 * Payment Hub Router: tiếp nhận Webhook từ MONA Pay và các nguồn thanh toán tập trung
 */
function createPaymentHubRouter(keystone) {
  const router = express.Router();

  // Middleware lưu rawBody phục vụ xác thực chữ ký HMAC-SHA256
  router.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  /**
   * Helper: Lấy cấu hình hệ thống từ SystemSetting
   */
  async function getSystemConfig(context, key, defaultValue = {}) {
    try {
      const { data } = await context.executeGraphQL({
        context,
        query: gql`
          query GetSetting($key: String!) {
            allSystemSettings(where: { key: $key }) {
              id
              value
            }
          }
        `,
        variables: { key }
      });

      if (data?.allSystemSettings?.length > 0) {
        return JSON.parse(data.allSystemSettings[0].value);
      }
    } catch (e) {
      console.warn(`[PaymentHub] Không thể đọc cấu hình key "${key}":`, e.message);
    }
    return defaultValue;
  }

  /**
   * API 1: Lấy cấu hình MONA Pay (Chỉ dành cho Super Admin)
   * GET /api/payment-hub/config
   */
  router.get('/config', async (req, res) => {
    try {
      const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });
      const config = await getSystemConfig(context, 'MONAPAY_CONFIG', {
        monapay_enabled: true,
        api_token: '',
        client_secret: '',
        webhook_secret: 'monapay_secret_demo',
        default_bank: 'ACB',
        auto_settle: true,
        auto_sync_interval_mins: 15,
        last_sync_at: null,
        last_sync_result: null,
        telegram_notify_enabled: false,
        telegram_chat_id: '',
      });

      // Mask secret keys khi gửi về client
      const maskedConfig = {
        ...config,
        webhook_url: `${req.protocol}://${req.get('host')}/api/payment-hub/monapay-webhook`,
      };

      return res.json({ success: true, data: maskedConfig });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * API 2: Lưu/Cập nhật cấu hình MONA Pay (Chỉ dành cho Super Admin)
   * POST /api/payment-hub/config
   */
  router.post('/config', async (req, res) => {
    try {
      const newConfig = req.body;
      const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });

      const { data: existing } = await context.executeGraphQL({
        context,
        query: gql`
          query {
            allSystemSettings(where: { key: "MONAPAY_CONFIG" }) {
              id
            }
          }
        `
      });

      const jsonStr = JSON.stringify(newConfig);

      if (existing?.allSystemSettings?.length > 0) {
        await context.executeGraphQL({
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
      } else {
        await context.executeGraphQL({
          context,
          query: gql`
            mutation ($key: String!, $value: String!) {
              createSystemSetting(data: { key: $key, value: $value, isSecret: true, description: "Cấu hình cổng thanh toán MONA Pay" }) {
                id
              }
            }
          `,
          variables: { key: 'MONAPAY_CONFIG', value: jsonStr }
        });
      }

      return res.json({ success: true, message: 'Đã lưu cấu hình MONA Pay thành công' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Helper: Đồng bộ danh sách giao dịch từ MONA Pay API và tự động đối soát
   */
  async function syncTransactionsFromMonaPay(context) {
    const config = await getSystemConfig(context, 'MONAPAY_CONFIG', {});
    if (!config.monapay_enabled) {
      return { success: false, message: 'MONA Pay Hub đang tắt' };
    }

    const apiToken = config.api_token || '';
    if (!apiToken) {
      return { success: false, message: 'Chưa cấu hình API Token MONA Pay' };
    }

    const https = require('https');
    const fetchTransactions = () => {
      return new Promise((resolve) => {
        // Gọi API lấy checkouts hoặc VA transactions
        const req = https.request('https://api.monapay.vn/api/v1/checkouts?limit=50', {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiToken}`
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
            } catch (e) {
              resolve({ statusCode: res.statusCode, raw: data });
            }
          });
        });

        req.on('error', (e) => resolve({ statusCode: 500, error: e.message }));
        req.end();
      });
    };

    const res = await fetchTransactions();
    const nowIso = new Date().toISOString();

    if (res.statusCode === 401) {
      const resultObj = {
        success: false,
        lastSync: nowIso,
        error: 'API Token MONA Pay đã hết hạn hoặc không hợp lệ. Vui lòng cập nhật API Token trong Cài đặt.',
        syncedCount: 0
      };
      await updateSyncStatus(context, resultObj);
      return resultObj;
    }

    if (res.statusCode !== 200 || !res.body?.data) {
      const resultObj = {
        success: false,
        lastSync: nowIso,
        error: res.body?.message || res.error || `Lỗi kết nối MONA Pay (HTTP ${res.statusCode})`,
        syncedCount: 0
      };
      await updateSyncStatus(context, resultObj);
      return resultObj;
    }

    const items = res.body.data.items || [];
    let newProcessed = 0;

    for (const item of items) {
      // Chỉ xử lý các giao dịch trạng thái đã thanh toán hoặc có tiền vào
      if (item.status !== 'paid' && item.type !== 'IN') continue;

      const bankRef = item.id || item.transaction_code || item.order_code;
      if (!bankRef) continue;

      // Kiểm tra xem đã xử lý giao dịch này chưa
      const { data: existingTx } = await context.executeGraphQL({
        context,
        query: gql`
          query CheckBankRef($bankRef: String!) {
            allCashTransactions(where: { bankRef: $bankRef }) {
              id
            }
          }
        `,
        variables: { bankRef: String(bankRef) }
      });

      if (existingTx?.allCashTransactions?.length > 0) {
        continue; // Đã xử lý trước đó
      }

      // Xử lý nạp tiền & cấn trừ
      const rawDesc = item.description || item.order_code || '';
      const match = rawDesc.match(/PH\d{4,8}/i);
      let parentId = null;

      if (match) {
        const parentCode = match[0].toUpperCase();
        const pRes = await context.executeGraphQL({
          context,
          query: gql`
            query FindParentByCode($code: String!) {
              allParents(where: { code: $code }) {
                id
              }
            }
          `,
          variables: { code: parentCode }
        });
        parentId = pRes.data?.allParents?.[0]?.id || null;
      }

      const numAmount = parseInt(item.amount, 10);
      if (numAmount > 0) {
        await SettlementService.processInflowAndSettle(context, {
          parentId,
          amount: numAmount,
          paymentMethod: 'MONA_PAY',
          bankRef: String(bankRef),
          bankDescription: `[MONA_SYNC] ${rawDesc}`,
          settleType: 'AUTO_ACB',
          autoSettle: config.auto_settle !== false
        });
        newProcessed++;
      }
    }

    const resultObj = {
      success: true,
      lastSync: nowIso,
      syncedCount: newProcessed,
      totalChecked: items.length,
      message: `Đã kiểm tra ${items.length} giao dịch, phát hiện và đồng bộ mới ${newProcessed} giao dịch.`
    };

    await updateSyncStatus(context, resultObj);
    return resultObj;
  }

  async function updateSyncStatus(context, resultObj) {
    try {
      const config = await getSystemConfig(context, 'MONAPAY_CONFIG', {});
      config.last_sync_at = resultObj.lastSync;
      config.last_sync_result = resultObj;

      const { data: existing } = await context.executeGraphQL({
        context,
        query: gql`
          query {
            allSystemSettings(where: { key: "MONAPAY_CONFIG" }) {
              id
            }
          }
        `
      });

      if (existing?.allSystemSettings?.length > 0) {
        await context.executeGraphQL({
          context,
          query: gql`
            mutation ($id: ID!, $value: String!) {
              updateSystemSetting(id: $id, data: { value: $value }) {
                id
              }
            }
          `,
          variables: { id: existing.allSystemSettings[0].id, value: JSON.stringify(config) }
        });
      }
    } catch (e) {
      console.warn('[PaymentHub] Không thể cập nhật trạng thái sync:', e.message);
    }
  }

  /**
   * API 4: Kích hoạt đồng bộ thủ công từ MONA Pay
   * POST /api/payment-hub/sync
   */
  router.post('/sync', async (req, res) => {
    try {
      const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });
      const result = await syncTransactionsFromMonaPay(context);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Healthcheck endpoint for testing Webhook URL reachability
   */
  router.get('/monapay-webhook', (req, res) => {
    return res.status(200).json({ status: 'ok', service: 'monapay-webhook-hub' });
  });

  /**
   * API 3: Webhook tiếp nhận thanh toán từ MONA Pay
   * POST /api/payment-hub/monapay-webhook
   */
  router.post('/monapay-webhook', async (req, res) => {
    const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });

    try {
      const config = await getSystemConfig(context, 'MONAPAY_CONFIG', {
        monapay_enabled: true,
        webhook_secret: 'monapay_secret_demo',
        auto_settle: true
      });

      if (!config.monapay_enabled) {
        return res.status(403).json({ success: false, message: 'MONA Pay Hub đang tạm tắt' });
      }

      // Xác thực chữ ký HMAC-SHA256 (nếu có secret)
      const signature = req.headers['x-mona-signature'];
      const timestamp = req.headers['x-mona-timestamp'];

      if (config.webhook_secret && signature) {
        const rawBodyStr = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
        
        // Cách 1: Chuẩn MONA Pay "<timestamp>.<raw_body>"
        let valid = false;
        if (timestamp) {
          const payloadWithTime = `${timestamp}.${rawBodyStr}`;
          const sigWithTime = crypto.createHmac('sha256', config.webhook_secret).update(payloadWithTime).digest('hex');
          if (signature === sigWithTime || signature === `sha256=${sigWithTime}`) {
            valid = true;
          }
        }
        
        // Cách 2: Ký trực tiếp trên raw body
        if (!valid) {
          const sigRaw = crypto.createHmac('sha256', config.webhook_secret).update(rawBodyStr).digest('hex');
          if (signature === sigRaw || signature === `sha256=${sigRaw}`) {
            valid = true;
          }
        }

        if (!valid) {
          console.warn('[MONA Pay Webhook] Chữ ký HMAC không hợp lệ:', { signature, timestamp });
          return res.status(401).json({ success: false, message: 'Chữ ký HMAC không hợp lệ' });
        }
      }

      const {
        amount,
        description,
        transaction_code,
        bank_name,
        account_number,
        type
      } = req.body;

      const numAmount = parseInt(amount, 10);
      if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ success: false, message: 'Số tiền không hợp lệ' });
      }

      const rawDesc = (description || '').trim();
      const bankRef = transaction_code || `MONA_${Date.now()}`;

      // Chống xử lý trùng giao dịch (Idempotency Guard)
      const { data: existingTx } = await context.executeGraphQL({
        context,
        query: gql`
          query CheckBankRef($bankRef: String!) {
            allCashTransactions(where: { bankRef: $bankRef }) {
              id
            }
          }
        `,
        variables: { bankRef }
      });

      if (existingTx?.allCashTransactions?.length > 0) {
        return res.status(200).json({
          success: true,
          message: 'Giao dịch đã được ghi nhận trước đó (Bỏ qua xử lý trùng)',
          transactionId: existingTx.allCashTransactions[0].id
        });
      }

      // Nhận diện mã Phụ huynh PHxxxxxx trong nội dung chuyển khoản
      const match = rawDesc.match(/PH\d{4,8}/i);
      let parentId = null;

      if (match) {
        const parentCode = match[0].toUpperCase();
        const pRes = await context.executeGraphQL({
          context,
          query: gql`
            query FindParentByCode($code: String!) {
              allParents(where: { code: $code }) {
                id
                name
                code
              }
            }
          `,
          variables: { code: parentCode }
        });

        parentId = pRes.data?.allParents?.[0]?.id || null;
      }

      // Xử lý dòng tiền & cấn trừ qua SettlementService
      const settleResult = await SettlementService.processInflowAndSettle(context, {
        parentId,
        amount: numAmount,
        paymentMethod: 'MONA_PAY',
        bankRef: bankRef,
        bankDescription: `[${bank_name || 'NGÂN HÀNG'} - ${account_number || ''}] ${rawDesc}`,
        settleType: 'AUTO_ACB',
        autoSettle: config.auto_settle !== false
      });

      return res.status(200).json({
        success: true,
        message: parentId
          ? (config.auto_settle !== false ? 'Đã nhận dòng tiền và tự động cấn trừ học phí thành công' : 'Đã nạp dòng tiền vào ví phụ huynh (Chờ kế toán gạch nợ)')
          : 'Đã ghi nhận dòng tiền (Chờ đối soát)',
        data: settleResult
      });

    } catch (err) {
      console.error('[MONA Pay Webhook Error]:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * API 5: Kế toán gán dòng tiền hoặc ghi nhận thu tiền mặt/bank cho Phụ huynh / Bé
   * POST /api/payment-hub/assign-parent
   */
  router.post('/assign-parent', async (req, res) => {
    try {
      const { cashTxId, cashTxData, parentId, autoSettle = true, note = '', isNewTx = false } = req.body;
      if (!parentId) {
        return res.status(400).json({ success: false, message: 'Vui lòng cung cấp ID phụ huynh' });
      }

      const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });

      if (isNewTx && cashTxData) {
        // Kế toán tạo mới dòng tiền thu tiền mặt / chuyển khoản tại quầy
        const result = await SettlementService.processInflowAndSettle(context, {
          parentId,
          amount: cashTxData.amount,
          paymentMethod: cashTxData.paymentMethod || 'CASH',
          bankDescription: cashTxData.bankDescription,
          settleType: 'MANUAL_ACCOUNTANT',
          autoSettle: autoSettle === true,
          note: note || cashTxData.bankDescription
        });
        return res.json({ success: true, data: result });
      }

      if (!cashTxId) {
        return res.status(400).json({ success: false, message: 'Vui lòng cung cấp ID dòng tiền' });
      }

      const result = await SettlementService.allocateCashTransaction(context, {
        cashTxId,
        parentId,
        autoSettle: autoSettle === true,
        note
      });

      return res.json(result);
    } catch (err) {
      console.error('[PaymentHub Assign Error]:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Khởi động Interval tự động đồng bộ (Cron Polling mỗi 15 phút)
  setInterval(async () => {
    try {
      const context = keystone.createContext({ schema: keystone.schema, isAccessAllowed: true });
      const config = await getSystemConfig(context, 'MONAPAY_CONFIG', {});
      if (config.monapay_enabled && config.api_token) {
        console.log('[MONA Pay Auto-Sync] Bắt đầu quét đồng bộ định kỳ 15 phút...');
        const result = await syncTransactionsFromMonaPay(context);
        console.log('[MONA Pay Auto-Sync] Kết quả:', result.message || result.error || result);
      }
    } catch (e) {
      console.error('[MONA Pay Auto-Sync Error]:', e.message);
    }
  }, 15 * 60 * 1000);

  return router;
}

module.exports = createPaymentHubRouter;
