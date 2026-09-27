const crypto = require('crypto');
const https = require('https');

// Contract: monapay.vn/docs/webhooks/bao-mat, /api/giao-dich,
// /api/xac-thuc and /api/sandbox (inspected 2026-09-27).
const secrets = ['api_token', 'client_secret', 'webhook_secret'];
const editable = ['monapay_enabled', 'client_id', 'default_bank', 'auto_settle',
  'auto_sync_interval_mins', 'telegram_notify_enabled', 'telegram_chat_id',
  'receiving_accounts', 'virtual_account_numbers', 'recovery_callback_url', 'webhook_max_age_seconds'];
const defaults = { monapay_enabled: false, default_bank: 'ACB', auto_settle: true,
  auto_sync_interval_mins: 15, telegram_notify_enabled: false, telegram_chat_id: '',
  webhook_max_age_seconds: 300 };
function callbackUrl(value) {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/api/payment-hub/monapay-webhook' && url.href === value;
  } catch (_) { return false; }
}
function freshnessPolicy(value = defaults.webhook_max_age_seconds) {
  // Local acceptance policy, NOT a claim that MONA re-signs delayed retries.
  if (!Number.isInteger(value) || value < 300 || value > 86400) fail('webhook_max_age_seconds phải từ 300 đến 86400', 503);
  return value;
}
function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function text(value, max = 255) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim();
}
function amount(value) {
  // Persistence uses GraphQL Int, not an arbitrary precision currency field.
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
    fail('Số tiền phải là số nguyên VND dương trong giới hạn GraphQL Int');
  }
  return value;
}
function publicConfig(config) {
  const result = { ...defaults };
  for (const key of editable) if (config[key] !== undefined) result[key] = config[key];
  for (const key of secrets) {
    result[key] = '';
    result[`${key}_configured`] = Boolean(config[key]);
  }
  result.last_sync_at = config.last_sync_at || null;
  // Do not reflect old, potentially credential-bearing upstream errors.
  const sync = config.last_sync_result;
  result.last_sync_result = sync ? {
    success: sync.success === true, syncedCount: sync.syncedCount || 0,
    totalChecked: sync.totalChecked || 0, lastSync: sync.lastSync || null,
    coverage: sync.coverage === 'webhook_log_recovery' ? 'webhook_log_recovery' : 'configured_va_transactions',
    fullBankReconciliation: false,
    message: sync.success === true ? 'Hoàn tất quét nguồn đã cấu hình; không phải đối soát toàn bộ ngân hàng' : 'Đồng bộ thất bại; kiểm tra cấu hình và dịch vụ'
  } : null;
  return result;
}
function mergeConfig(existing, input) {
  if (!object(input)) fail('Cấu hình không hợp lệ');
  const result = { ...defaults, ...existing };
  for (const key of editable) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (['monapay_enabled', 'auto_settle', 'telegram_notify_enabled'].includes(key)) {
      if (typeof value !== 'boolean') fail(`${key} phải là boolean`);
    } else if (key === 'recovery_callback_url') {
      if (!callbackUrl(value)) fail('recovery_callback_url phải là URL HTTPS callback chính xác của trường');
    } else if (key === 'webhook_max_age_seconds') {
      if (!Number.isInteger(value) || value < 300 || value > 86400) fail('webhook_max_age_seconds phải từ 300 đến 86400');
    } else if (key === 'auto_sync_interval_mins') {
      if (!Number.isInteger(value) || value < 1 || value > 1440) fail('Chu kỳ đồng bộ không hợp lệ');
    } else if (['receiving_accounts', 'virtual_account_numbers'].includes(key)) {
      if (!Array.isArray(value) || value.length > 100 || value.some(v => !text(v, 50) || /^SBX/i.test(v))) fail(`${key} không hợp lệ`);
    } else if (typeof value !== 'string' || value.length > 255) fail(`${key} không hợp lệ`);
    result[key] = value;
  }
  for (const key of secrets) {
    if (input[key] === undefined || input[key] === '') continue; // Blank form preserves secret.
    if (input[key] === null) { result[key] = ''; continue; } // Explicit clear.
    if (!text(input[key], 8192) || /^\*+$/.test(input[key]) || input[key] === 'monapay_secret_demo') fail(`${key} không hợp lệ`);
    result[key] = input[key];
  }
  return result;
}
function verifyWebhook(req, secret, now = Date.now(), maxAgeSeconds = defaults.webhook_max_age_seconds) {
  const maxAge = freshnessPolicy(maxAgeSeconds);
  if (!text(secret, 8192) || secret === 'monapay_secret_demo') fail('Chưa cấu hình webhook secret an toàn', 503);
  const timestamp = req.headers['x-mona-timestamp'];
  const signature = req.headers['x-mona-signature'];
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) ||
      now / 1000 - Number(timestamp) > maxAge || Number(timestamp) - now / 1000 > 300 ||
      typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature) ||
      !Buffer.isBuffer(req.rawBody)) fail('Chữ ký hoặc timestamp không hợp lệ', 401);
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(req.rawBody).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) fail('Chữ ký không hợp lệ', 401);
}
function receivingAccounts(config) {
  // Only use an explicitly configured existing VietQR account as fallback.
  return config.receiving_accounts || (process.env.VIETQR_ACCOUNT_NO ? [process.env.VIETQR_ACCOUNT_NO] : []);
}
function inbound(payload, config) {
  if (!object(payload)) fail('Payload không hợp lệ');
  for (const key of ['is_sandbox', 'sandbox', 'is_test']) {
    if (payload[key] !== undefined && payload[key] !== false) fail('Không ghi nhận giao dịch thử');
  }
  // Observed live payloads have flags: []; unknown flags are not verified money.
  if (payload.flags !== undefined && (!Array.isArray(payload.flags) || payload.flags.length)) fail('Cờ giao dịch chưa được xác minh');
  if (/^(SANDBOX|TEST[_-])/i.test(payload.transaction_code || '') || /^SBX/i.test(payload.account_number || '')) fail('Không ghi nhận giao dịch thử');
  if (payload.type !== 'income') fail('Chỉ nhận giao dịch income');
  if (payload.currency !== undefined && payload.currency !== 'VND') fail('Chỉ nhận VND');
  amount(payload.amount);
  if (!text(payload.transaction_code, 100)) fail('Thiếu mã giao dịch ngân hàng ổn định');
  if (!text(payload.account_number, 50)) fail('Thiếu tài khoản nhận');
  const accounts = receivingAccounts(config);
  if (!Array.isArray(accounts) || !accounts.length) fail('Chưa cấu hình receiving_accounts', 503);
  if (!accounts.includes(payload.account_number)) fail('Sai tài khoản nhận', 403);
  if (!text(payload.bank_name, 100) || payload.bank_name !== config.default_bank) fail('Sai ngân hàng nhận');
  if (payload.description !== undefined && (typeof payload.description !== 'string' || payload.description.length > 4096)) fail('Nội dung không hợp lệ');
  return { bankRef: payload.transaction_code, providerReference: payload.transaction_code,
    receivingAccount: payload.account_number, amount: payload.amount,
    bankDescription: `[${payload.bank_name} - ${payload.account_number}] ${(payload.description || '').trim()}`,
    description: (payload.description || '').trim() };
}
function canSync(config) {
  return config.monapay_enabled === true && Boolean(config.api_token || (config.client_id && config.client_secret));
}
function requestJson(path, { token, form } = {}, transport = https) {
  return new Promise((resolve, reject) => {
    const payload = form ? new URLSearchParams(form).toString() : undefined;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = transport.request(`https://api.monapay.vn${path}`, { method: payload ? 'POST' : 'GET', headers }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (Buffer.byteLength(data) > 2 * 1024 * 1024) req.destroy(new Error('MONA response too large'));
      });
      res.on('error', () => reject(new Error('MONA response error')));
      res.on('aborted', () => reject(new Error('MONA response aborted')));
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300 || body.success !== true) throw new Error();
          resolve(body.data);
        } catch (_) { reject(new Error(`MONA request failed (HTTP ${res.statusCode})`)); }
      });
    });
    // Absolute deadline also bounds slow-drip responses.
    const deadline = setTimeout(() => req.destroy(new Error('MONA request timeout')), 15000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', () => { clearTimeout(deadline); reject(new Error('MONA network error or timeout')); });
    req.end(payload);
  });
}
async function fetchTransactions(config, request = requestJson) {
  if (!canSync(config)) fail('MONA Pay đang tắt hoặc thiếu thông tin xác thực', 503);
  if (config.virtual_account_numbers !== undefined && !Array.isArray(config.virtual_account_numbers)) fail('virtual_account_numbers không hợp lệ', 503);
  const useLogs = !config.virtual_account_numbers?.length;
  if (useLogs && !callbackUrl(config.recovery_callback_url)) fail('Cần cấu hình recovery_callback_url chính xác cho phục hồi giao dịch', 503);
  if (!Array.isArray(receivingAccounts(config)) || !receivingAccounts(config).length) fail('Chưa cấu hình receiving_accounts', 503);
  let token = config.api_token;
  if (config.client_id && config.client_secret) {
    const auth = await request('/api/v1/oauth/token', { form: {
      grant_type: 'client_credentials', client_id: config.client_id, client_secret: config.client_secret
    } });
    if (!auth || !text(auth.access_token, 8192)) throw new Error('MONA OAuth response invalid');
    token = auth.access_token;
  }
  if (useLogs) return fetchRecoveryLogs(config, token, request);
  const transactions = [];
  for (const va of config.virtual_account_numbers) {
    if (!text(va, 50) || /^SBX/i.test(va)) fail('VA đối soát không hợp lệ');
    for (let page = 1; ; page++) {
      if (page > 1000) throw new Error('MONA pagination limit exceeded');
      const data = await request(`/api/v1/acb/virtual-account/transactions?virtual_account_number=${encodeURIComponent(va)}&page=${page}&limit=100`, { token });
      if (!object(data) || !Array.isArray(data.data) || data.current_page !== page || typeof data.has_next !== 'boolean' || (data.has_next && !data.data.length)) throw new Error('MONA pagination response invalid');
      for (const tx of data.data) {
        if (!object(tx)) throw new Error('MONA transaction response invalid');
        if (tx.transaction_status !== 'SUCCESS' || tx.debit_or_credit !== 'credit') continue;
        try {
          transactions.push(inbound({ ...tx, type: 'income', bank_name: 'ACB',
            account_number: tx.va_nbr || tx.account_number, description: tx.transaction_content }, config));
        } catch (error) {
          if (error.status === 503) throw error;
          // Foreign-account, invalid and sandbox rows never enter accounting.
        }
      }
      if (!data.has_next) break;
    }
  }
  return transactions;
}
// Authenticated delivery history is a LIMITED recovery feed, not bank history.
// Cached /docs/api/webhook-configs: items,total,page,limit; observed event type
// rtxn_callback differs from the generic documentation example "webhook".
async function fetchRecoveryLogs(config, token, request) {
  const transactions = [];
  let total;
  for (let page = 1; ; page++) {
    if (page > 1000) throw new Error('MONA recovery pagination limit exceeded');
    const data = await request(`/api/v1/webhook-logs?page=${page}&limit=100`, { token });
    if (!object(data) || !Array.isArray(data.items) || data.page !== page || data.limit !== 100 ||
        !Number.isSafeInteger(data.total) || data.total < 0 || data.items.length > 100) throw new Error('MONA recovery pagination response invalid');
    if (total === undefined) total = data.total;
    // Offset pagination cannot promise a consistent scan if the feed shifts.
    if (data.total !== total || data.items.length !== Math.min(100, Math.max(0, total - (page - 1) * 100))) throw new Error('MONA recovery feed changed or page incomplete; retry scan');
    for (const log of data.items) {
      if (!object(log) || log.event_type !== 'rtxn_callback' || log.endpoint_url !== config.recovery_callback_url) continue;
      try {
        for (const key of ['is_sandbox', 'sandbox', 'is_test']) {
          if (log[key] !== undefined && log[key] !== false) fail('Test log');
        }
        const payload = typeof log.request_payload === 'string' ? JSON.parse(log.request_payload) : log.request_payload;
        // Never trust log IDs, checkout IDs, or response status as bank evidence.
        transactions.push(inbound(payload, config));
      } catch (error) {
        if (error.status === 503) throw error;
      }
    }
    if (page * 100 >= total) break;
  }
  return transactions;
}
module.exports = { defaults, publicConfig, mergeConfig, verifyWebhook, inbound, amount,
  text, fail, canSync, requestJson, fetchTransactions };
