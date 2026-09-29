const test = require('node:test');
const assert = require('node:assert/strict');
const { Keystone } = require('@keystonejs/keystone');
const { MongooseAdapter } = require('@keystonejs/adapter-mongoose');
const { print } = require('graphql');

test('camera configuration keeps internal operations while denying public access', () => {
  const definition = require('../lists/CameraIntegration');
  const k = new Keystone({ name: 'schema-fixture', cookieSecret: 'fixture-schema-only',
    adapter: new MongooseAdapter({ mongoUri: 'mongodb://127.0.0.1:1/never-connected' }) });
  k.createList('CameraIntegration', definition);
  const schema = k.getTypeDefs({ schemaName: 'public' }).map(d => typeof d === 'string' ? d : print(d)).join('\n');
  for (const operation of ['allCameraIntegrations', 'createCameraIntegration', 'updateCameraIntegration']) {
    assert.ok(schema.includes(operation + '('), operation);
  }
  for (const rule of Object.values(definition.access)) assert.equal(rule(), false);
});
