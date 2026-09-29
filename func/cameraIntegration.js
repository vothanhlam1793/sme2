const https = require('https');

function fail(message, status = 400) {
  const error = new Error(message); error.status = status; throw error;
}
function normalizePhone(raw) {
  let phone = String(raw || '').replace(/\D/g, '');
  if (phone.startsWith('84')) phone = '0' + phone.slice(2);
  if (!/^0[1-9]\d{8,9}$/.test(phone)) fail('Số điện thoại không hợp lệ');
  return phone;
}
function baseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { fail('Địa chỉ camera không hợp lệ'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('Nhập địa chỉ gốc HTTPS của hệ thống camera, không kèm đường dẫn');
  }
  return url.origin;
}
function cameraRequest(config, path, data) {
  if (!config.baseUrl || !config.apiKey) fail('Chưa cấu hình kết nối camera', 503);
  const url = new URL(`/api/school/${path}`, baseUrl(config.baseUrl));
  return new Promise((resolve, reject) => {
    const error = message => Object.assign(new Error(message), { status: 502 });
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = https.request(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-school-api-key': config.apiKey, 'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
      let text = '';
      res.on('data', chunk => {
        text += chunk;
        if (Buffer.byteLength(text) > 1024 * 1024) req.destroy(error('Phản hồi camera quá lớn'));
      });
      res.on('error', () => reject(error('Kết nối camera bị gián đoạn')));
      res.on('end', () => {
        let result;
        try { result = JSON.parse(text); } catch (_) { return reject(error('Phản hồi camera không hợp lệ')); }
        if (res.statusCode < 200 || res.statusCode >= 300 || result.success !== true) {
          return reject(Object.assign(error(result.message || 'Hệ thống camera từ chối yêu cầu'),
            { code: result.error, status: res.statusCode === 404 ? 404 : 502 }));
        }
        resolve(result);
      });
    });
    const timeout = setTimeout(() => req.destroy(error('Hết thời gian kết nối camera')), 10000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', () => reject(error('Không thể kết nối hệ thống camera')));
    req.end(body);
  });
}
function entitlement(phone, mapping) {
  const parent = phone.parent;
  if (!parent) fail('Số điện thoại chưa liên kết hồ sơ phụ huynh');
  const students = parent.status === 'DEACTIVE' ? [] : (parent.hocsinhs || []).filter(s => s.status === 'DANG_HOC');
  const missing = students.filter(s => !s.lophoc || !mapping[s.lophoc.id]);
  if (missing.length) fail(`Chưa liên kết lớp camera: ${missing.map(s => s.lophoc?.name || s.name).join(', ')}`, 409);
  const allStudents = parent.hocsinhs || [];
  return { phone: normalizePhone(phone.number), name: phone.name || parent.name,
    classIds: [...new Set(students.map(s => mapping[s.lophoc.id]))],
    disableAccount: allStudents.length > 0 && allStudents.every(s => s.status === 'NGHI_LUON') };
}
function accountRequest(config, phone) {
  return cameraRequest(config, `parent?phone=${encodeURIComponent(phone)}`).then(result => result.data)
    .catch(error => error.code === 'USER_NOT_FOUND' ? null : Promise.reject(error));
}
async function syncPhoneCamera(config, phone, request = cameraRequest, lookup = accountRequest) {
  const account = await lookup(config, normalizePhone(phone.number));
  if (!account) return { skipped: true, reason: 'ACCOUNT_NOT_FOUND' };
  const access = entitlement(phone, config.mapping || {});
  if (access.classIds.length) {
    if (account.state === 'DISABLED') await request(config, 'toggle-account', { phone: access.phone, enabled: true });
    await request(config, 'assign-class', { phone: access.phone, classIds: access.classIds });
    await request(config, 'toggle-active', { phone: access.phone, active: true });
    return { synced: true, classIds: access.classIds };
  }
  await request(config, 'toggle-active', { phone: access.phone, active: false });
  if (access.disableAccount) {
    await request(config, 'toggle-account', { phone: access.phone, enabled: false });
    return { disabled: true };
  }
  return { suspended: true };
}
module.exports = { fail, normalizePhone, baseUrl, cameraRequest, entitlement, accountRequest, syncPhoneCamera };
