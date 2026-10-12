import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InputError, validateConfig, type TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar'], sections: {bar: 'Bar'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null,
};

test('config: web is only the bare HTTPS origin of an allowed website, never a token', () => {
  const {web: _omit, ...legacy} = config;
  assert.equal(validateConfig(legacy).web, null, 'configs without the key stay valid');
  assert.equal(validateConfig({...config, web: null}).web, null);
  assert.deepEqual(validateConfig({...config, web: {url: 'https://jamesdean.cz'}}).web, {url: 'https://jamesdean.cz'});
  assert.deepEqual(validateConfig({...config, web: {url: 'https://JamesDean.cz/'}}).web, {url: 'https://jamesdean.cz'});
  for (const url of ['http://jamesdean.cz', 'https://evil.example', 'https://jamesdean.cz.evil.example', 'https://evil.example/jamesdean.cz',
    'https://www.evil.cz?jamesdean.cz', 'https://jamesdean.cz/api', 'https://jamesdean.cz/?a=1', 'https://jamesdean.cz:8443',
    'https://user@jamesdean.cz', 'jamesdean.cz', '']) {
    assert.throws(() => validateConfig({...config, web: {url}}), InputError, url);
  }
  assert.throws(() => validateConfig({...config, web: {url: 'https://jamesdean.cz', token: 'a'.repeat(64)}}), InputError, 'no token in the config');
  assert.throws(() => validateConfig({...config, web: 'https://jamesdean.cz'}), InputError);
});
