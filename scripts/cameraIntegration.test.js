const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { entitlement, normalizePhone, baseUrl } = require('../func/cameraIntegration');
const createRouter = require('../routes/cameraIntegration');

test('entitlements aggregate current children, deduplicate classes and reject unmapped children', () => {
  const phone = { number: '+84 901234567', parent: { name: 'Parent', hocsinhs: [
    { name: 'A', status: 'DANG_HOC', lophoc: { id: 'c1' } },
    { name: 'B', status: 'DANG_HOC', lophoc: { id: 'c2' } },
    { name: 'C', status: 'THOI_HOC', lophoc: { id: 'c3' } },
  ] } };
  assert.deepEqual(entitlement(phone, { c1: 'cam1', c2: 'cam2' }).classIds, ['cam1', 'cam2']);
  assert.deepEqual(entitlement(phone, { c1: 'cam1', c2: 'cam1' }).classIds, ['cam1']);
  assert.throws(() => entitlement(phone, { c1: 'cam1' }), /Chưa liên kết/);
  phone.parent.status = 'DEACTIVE';
  assert.deepEqual(entitlement(phone, {}).classIds, []);
  assert.equal(normalizePhone('+84 901234567'), '0901234567');
  assert.throws(() => normalizePhone('bad'));
  for (const url of ['http://camera.test', 'https://user:pass@camera.test', 'https://camera.test/path', 'https://camera.test/?key=secret']) assert.throws(() => baseUrl(url));
  assert.equal(baseUrl('https://camera.test/'), 'https://camera.test');
});

test('management HTTP authentication, secret redaction, mapping validation and account lifecycle', async t => {
  let config = { baseUrl: 'https://camera.invalid', apiKey: 'fixture-only-key', mapping: { school1: 'camera1' } };
  let account = { id: 'u1', state: 'DISABLED', active: false, lophoc: [] };
  const phone = { id: 'p1', number: '0901234567', name: 'Mother', parent: { status: 'ACTIVE', name: 'Parent',
    hocsinhs: [{ name: 'Child', status: 'DANG_HOC', lophoc: { id: 'school1', name: 'Class 1' } }] } };
  const writes = [], requests = [];
  let queries = 0, upstreamFailure = false;
  const keystone = {
    _sessionManager: { getSessionMiddleware: () => (req, res, next) => {
      if (req.get('authorization') === 'Bearer admin') { req.user = { isAdmin: true }; req.authedListKey = 'User'; }
      if (req.get('authorization') === 'Bearer staff') { req.user = { isAdmin: false }; req.authedListKey = 'User'; }
      next();
    } },
    createContext: () => ({ executeGraphQL: async ({ query, variables }) => {
      queries++;
      if (query.includes('allCameraIntegrations')) return { data: { allCameraIntegrations: [{ id: 'settings', value: JSON.stringify(config) }] } };
      if (query.includes('allLopHocs')) return { data: { allLopHocs: [{ id: 'school1', name: 'Class 1' }] } };
      if (query.includes('updateCameraIntegration')) { config = JSON.parse(variables.value); return { data: { updateCameraIntegration: { id: 'settings' } } }; }
      if (query.includes('Phone(where:')) return { data: { Phone: variables.id === 'p1' ? phone : null } };
      throw new Error('Unexpected query');
    } })
  };
  const request = async (settings, path, data) => {
    requests.push({ settings, path, data });
    if (upstreamFailure) throw Object.assign(new Error('Offline'), { status: 502 });
    if (path.startsWith('parent?')) {
      if (!account) throw Object.assign(new Error('Missing'), { status: 404, code: 'USER_NOT_FOUND' });
      return { success: true, data: account };
    }
    if (path === 'classes') return { success: true, data: [{ id: 'camera1', name: 'Camera class' }] };
    writes.push({ path, data });
    return { success: true, action: account ? 'UPDATED' : 'CREATED', data: {} };
  };
  const app = express(); app.use('/api/camera-integration', createRouter(keystone, { request }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  async function call(path, body, token = 'admin') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/camera-integration/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }
  for (const token of ['forged', 'staff']) {
    assert.equal((await call('config', undefined, token)).status, token === 'staff' ? 403 : 401);
    assert.equal((await call('phones/p1/sync', {}, token)).status, token === 'staff' ? 403 : 401);
  }
  assert.equal(queries, 0); assert.equal(requests.length, 0);
  const read = await call('config');
  assert.equal(read.body.data.apiKeyConfigured, true);
  assert.equal(JSON.stringify(read).includes('fixture-only-key'), false);
  assert.equal((await call('config', { baseUrl: config.baseUrl, mapping: { school1: 'missing' } })).status, 409);
  assert.equal((await call('test', { baseUrl: 'https://other.invalid' })).status, 400);
  assert.equal((await call('config', { baseUrl: config.baseUrl, mapping: config.mapping })).status, 200);
  assert.equal(config.apiKey, 'fixture-only-key');
  assert.equal((await call('phones/p1/sync', {})).status, 200);
  assert.deepEqual(writes.pop(), { path: 'sync-parent', data: { phone: phone.number, name: phone.name, username: phone.number, classIds: ['camera1'] } });
  assert.equal(account.state, 'DISABLED');
  phone.parent.hocsinhs[0].status = 'THOI_HOC';
  assert.equal((await call('phones/p1/sync', {})).status, 200);
  assert.deepEqual(writes.pop(), { path: 'toggle-active', data: { phone: phone.number, active: false } });
  assert.equal((await call('phones/p1/toggle-active', { active: true })).status, 409);
  account = null;
  assert.equal((await call('phones/p1')).body.data.account, null);
  assert.equal((await call('phones/p1/sync-existing', {})).body.skipped, true);
  assert.equal((await call('phones/p1/sync', {})).status, 409);
  phone.parent.hocsinhs[0].status = 'DANG_HOC';
  const created = await call('phones/p1/sync', {});
  assert.equal(created.status, 200); assert.match(created.body.temporaryPin, /^\d{4}$/);
  assert.equal(writes.pop().data.createOnly, true);
  config.mapping = {};
  const count = writes.length;
  assert.equal((await call('phones/p1/sync', {})).status, 409);
  assert.equal(writes.length, count);
  upstreamFailure = true;
  assert.equal((await call('phones/p1')).status, 502);
  assert.equal((await call('phones/unknown')).status, 404);
});
