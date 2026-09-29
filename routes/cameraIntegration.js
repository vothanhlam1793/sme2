const express = require('express');
const crypto = require('crypto');
const { access } = require('../setting/access');
const { fail, baseUrl, normalizePhone, cameraRequest, entitlement } = require('../func/cameraIntegration');

module.exports = (keystone, { request = cameraRequest } = {}) => {
  const router = express.Router();
  router.use(keystone._sessionManager.getSessionMiddleware({ keystone }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user || req.authedListKey !== 'User') return res.status(401).json({ success: false, error: 'Cần đăng nhập' });
    if (!access.userIsAdmin({ authentication: { item: req.user } })) return res.status(403).json({ success: false, error: 'Cần quyền quản trị' });
    next();
  });
  router.use(express.json({ limit: '64kb' }));
  const handle = fn => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Không thể hoàn tất thao tác camera' });
    }
  };
  async function execute(query, variables) {
    const context = keystone.createContext({ skipAccessControl: true });
    const result = await context.executeGraphQL({ context, query, variables });
    if (result.errors?.length || !result.data) throw new Error('Camera integration database operation failed');
    return result.data;
  }
  async function setting() {
    const data = await execute('query { allCameraIntegrations(where: {key: "school"}) { id value } }');
    const row = data.allCameraIntegrations[0];
    return { id: row?.id, config: row ? JSON.parse(row.value) : { baseUrl: '', mapping: {} } };
  }
  const publicConfig = config => ({ baseUrl: config.baseUrl, apiKeyConfigured: !!config.apiKey, mapping: config.mapping || {} });
  async function schoolClasses() {
    return (await execute('query { allLopHocs { id name } }')).allLopHocs;
  }
  async function phoneById(id) {
    const { Phone } = await execute(`query ($id: ID!) { Phone(where: {id: $id}) {
      id number name parent { id name status hocsinhs { id name status lophoc { id name } } }
    } }`, { id });
    if (!Phone) fail('Không tìm thấy số điện thoại', 404);
    return Phone;
  }
  async function lookup(config, phone) {
    try { return (await request(config, `parent?phone=${encodeURIComponent(phone)}`)).data; }
    catch (error) { if (error.code === 'USER_NOT_FOUND') return null; throw error; }
  }
  async function validateClasses(config, ids) {
    const result = await request(config, 'classes');
    if (!Array.isArray(result.data)) fail('Danh sách lớp camera không hợp lệ', 502);
    if (ids.some(id => !result.data.some(c => c.id === id))) fail('Lớp camera đã thay đổi. Kiểm tra lại liên kết lớp', 409);
    return result.data;
  }
  router.get('/config', handle(async (req, res) => {
    res.json({ success: true, data: { ...publicConfig((await setting()).config), schoolClasses: await schoolClasses() } });
  }));
  router.post('/config', handle(async (req, res) => {
    const { id, config } = await setting();
    const origin = baseUrl(req.body.baseUrl);
    if (config.baseUrl && origin !== config.baseUrl && !req.body.apiKey) fail('Cần nhập API key khi đổi hệ thống camera');
    const apiKey = req.body.apiKey || config.apiKey;
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey !== apiKey.trim() || /[\r\n]/.test(apiKey) || apiKey.length > 4096) fail('API key không hợp lệ');
    const mapping = req.body.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) fail('Liên kết lớp không hợp lệ');
    const classes = await schoolClasses();
    for (const [schoolId, cameraId] of Object.entries(mapping)) {
      if (!classes.some(c => c.id === schoolId) || typeof cameraId !== 'string') fail('Liên kết lớp không hợp lệ');
    }
    const next = { baseUrl: origin, apiKey, mapping: Object.fromEntries(Object.entries(mapping).filter(([, value]) => value)) };
    await validateClasses(next, Object.values(next.mapping));
    const value = JSON.stringify(next);
    await execute(id ? `mutation ($id: ID!, $value: String!) { updateCameraIntegration(id: $id, data: {value: $value}) { id } }`
      : `mutation ($value: String!) { createCameraIntegration(data: {key: "school", value: $value}) { id } }`, { id, value });
    res.json({ success: true, data: publicConfig(next) });
  }));
  router.post('/test', handle(async (req, res) => {
    const { config } = await setting();
    const origin = baseUrl(req.body.baseUrl || config.baseUrl);
    if (origin !== config.baseUrl && !req.body.apiKey) fail('Cần nhập API key cho hệ thống camera mới');
    const classes = await validateClasses({ baseUrl: origin, apiKey: req.body.apiKey || config.apiKey }, []);
    res.json({ success: true, data: classes });
  }));
  router.get('/phones', handle(async (req, res) => {
    const data = await execute('query { allPhones { id number } }');
    res.json({ success: true, data: data.allPhones });
  }));
  router.get('/phones/:id', handle(async (req, res) => {
    const phone = await phoneById(req.params.id);
    const { config } = await setting();
    const account = await lookup(config, normalizePhone(phone.number));
    let expected = null, mappingError = null;
    try { expected = entitlement(phone, config.mapping || {}); } catch (error) { mappingError = error.message; }
    res.json({ success: true, data: { account, expected, mappingError } });
  }));
  router.post('/phones/:id/:action', handle(async (req, res) => {
    const actions = ['sync', 'sync-existing', 'toggle-active', 'reset-pin', 'unblock', 'toggle-account'];
    if (!actions.includes(req.params.action)) fail('Thao tác không hợp lệ', 404);
    const phone = await phoneById(req.params.id);
    const number = normalizePhone(phone.number);
    const { config } = await setting();
    const action = req.params.action;
    let result;
    if (action === 'sync' || action === 'sync-existing') {
      const account = await lookup(config, number);
      if (!account && action === 'sync-existing') return res.json({ success: true, skipped: true });
      const expected = entitlement(phone, config.mapping || {});
      if (!expected.classIds.length) {
        if (!account) fail('Không có bé đang học để cấp tài khoản camera', 409);
        // Nghỉ học: chỉ tắt quyền camera, giữ nguyên lớp, PIN và trạng thái tài khoản.
        return res.json(await request(config, 'toggle-active', { phone: number, active: false }));
      }
      await validateClasses(config, expected.classIds);
      const payload = { ...expected, username: number };
      // Preserve explicit camera suspension and PIN on routine synchronization.
      if (!account) Object.assign(payload, { createOnly: true, active: true, password: String(crypto.randomInt(1000, 10000)) });
      result = await request(config, 'sync-parent', payload);
      if (!account && result.action === 'CREATED') result.temporaryPin = payload.password;
    } else {
      const payload = { phone: number };
      if (action === 'toggle-active') {
        if (typeof req.body.active !== 'boolean') fail('Trạng thái camera không hợp lệ');
        if (req.body.active) {
          const expected = entitlement(phone, config.mapping || {});
          if (!expected.classIds.length) fail('Không có bé đang học để bật camera', 409);
          await validateClasses(config, expected.classIds);
          await request(config, 'assign-class', { phone: number, classIds: expected.classIds });
        }
        payload.active = req.body.active;
      }
      if (action === 'toggle-account') {
        if (typeof req.body.enabled !== 'boolean') fail('Trạng thái tài khoản không hợp lệ');
        payload.enabled = req.body.enabled;
      }
      if (action === 'reset-pin') payload.pin = String(crypto.randomInt(1000, 10000));
      result = await request(config, action, payload);
    }
    res.json(result);
  }));
  return router;
};
