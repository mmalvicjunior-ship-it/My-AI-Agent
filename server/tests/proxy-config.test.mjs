import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { backendPortFromEnv, configureApiProxy, createViteConfig } from '../../apps/web/vite.config.js';
import { createProviderNetworkError } from '../src/ai/provider-error.js';

test('Vite API proxy targets the backend configured by PORT', () => {
  assert.equal(backendPortFromEnv({ PORT: '3002' }), 3002);
  assert.equal(backendPortFromEnv({ PORT: 'invalid' }), 3001);
  assert.equal(createViteConfig({ PORT: '3002' }).server.proxy['/api'].target, 'http://127.0.0.1:3002');
  assert.equal(createViteConfig({}).server.proxy['/api'].target, 'http://127.0.0.1:3001');
});

test('API proxy returns a clear backend connection error', () => {
  const proxy = new EventEmitter();
  const headers = {};
  let responseBody = '';
  let responseStatus;
  configureApiProxy(proxy, 'http://127.0.0.1:3001');
  proxy.emit('error', new Error('ECONNREFUSED'), {}, {
    destroyed: false,
    headersSent: false,
    writeHead(status, values) {
      responseStatus = status;
      Object.assign(headers, values);
    },
    end(body) {
      responseBody = body;
    },
  });

  assert.equal(responseStatus, 502);
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
  assert.match(JSON.parse(responseBody).error, /Cannot reach the backend/);
  assert.doesNotMatch(JSON.parse(responseBody).error, /Gemini/);

  const geminiTimeout = createProviderNetworkError('Gemini', { name: 'TimeoutError' });
  assert.equal(geminiTimeout.statusCode, 504);
  assert.match(geminiTimeout.publicMessage, /Gemini did not respond/);
});
