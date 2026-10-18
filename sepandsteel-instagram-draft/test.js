'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const { createServer, verifyWebhookSignature, WEBHOOK_PATH } = require('./server');
const { DedupeStore } = require('./store');
const { loadConfig } = require('./config');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepandsteel-test-'));
const env = {
  ENABLE_WEBHOOK_RECEIVER: 'true', ENABLE_OUTBOUND_REPLIES: 'false',
  META_APP_SECRET: 'a'.repeat(40), META_VERIFY_TOKEN: 'v'.repeat(40), DEDUPE_HMAC_KEY: 'd'.repeat(40),
  INSTAGRAM_ACCOUNT_IDS: '123', DEDUPE_DB_PATH: path.join(dir, 'receipts.sqlite'),
};
const config = loadConfig(env);
const store = new DedupeStore(config);
const logs = [];
const server = createServer(config, store, record => logs.push(record));
const listening = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(async () => {
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
async function endpoint(route = WEBHOOK_PATH) { await listening; return `http://127.0.0.1:${server.address().port}${route}`; }
const message = (id = 'mid-1', account = '123', extra = {}) => ({ object: 'instagram', entry: [{ id: account, messaging: [{ sender: { id: '456' }, recipient: { id: account }, message: { mid: id, text: 'PRIVATE_SENTINEL_9471', ...extra } }] }] });
async function post(payload, overrides = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', config.appSecret).update(body).digest('hex')}`;
  return fetch(await endpoint(), { method: 'POST', body, ...overrides, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, ...overrides.headers } });
}
test('startup is disabled by default and invalid toggles fail closed', () => {
  assert.throws(() => loadConfig({}), /disabled/);
  assert.throws(() => loadConfig({ ...env, ENABLE_WEBHOOK_RECEIVER: 'TRUE' }));
  assert.throws(() => loadConfig({ ...env, ENABLE_OUTBOUND_REPLIES: 'true' }), /not implemented/);
  assert.throws(() => loadConfig({ ...env, ENABLE_OUTBOUND_REPLIES: '1' }));
  const child = spawnSync(process.execPath, ['server.js'], { cwd: __dirname, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(child.status, 1); assert.match(child.stderr, /Startup refused/);
});
test('credentials, account allowlist, paths and bounds are mandatory', () => {
  for (const patch of [{ META_APP_SECRET: 'short' }, { META_VERIFY_TOKEN: env.META_APP_SECRET }, { INSTAGRAM_ACCOUNT_IDS: '' }, { INSTAGRAM_ACCOUNT_IDS: '@sepandsteel' }, { DEDUPE_DB_PATH: 'relative.sqlite' }, { PORT: '1e3' }, { MAX_EVENTS_PER_REQUEST: '0' }]) assert.throws(() => loadConfig({ ...env, ...patch }));
});
test('verification accepts only one matching token and returns challenge', async () => {
  const url = new URL(await endpoint());
  url.search = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.verifyToken, 'hub.challenge': 'local-challenge' });
  const good = await fetch(url); assert.equal(good.status, 200); assert.equal(await good.text(), 'local-challenge');
  url.searchParams.append('hub.verify_token', config.verifyToken); assert.equal((await fetch(url)).status, 403);
  url.searchParams.set('hub.verify_token', 'wrong'); assert.equal((await fetch(url)).status, 403);
});
test('raw-body HMAC rejects tampering, malformed and missing signatures', async () => {
  const body = Buffer.from('{"x":1}');
  const sig = `sha256=${crypto.createHmac('sha256', config.appSecret).update(body).digest('hex')}`;
  assert.equal(verifyWebhookSignature(body, sig, config.appSecret), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{"x": 1}'), sig, config.appSecret), false);
  for (const header of [undefined, 'sha1=abc', 'sha256=zz', `${sig},${sig}`]) assert.equal(verifyWebhookSignature(body, header, config.appSecret), false);
  assert.equal((await post(message(), { headers: { 'x-hub-signature-256': '' } })).status, 401);
});
test('invalid JSON, object, entries and missing IDs fail schema validation', async () => {
  for (const payload of ['{', 'null', '[]', { object: 'page', entry: [] }, { object: 'instagram', entry: null }, { object: 'instagram', entry: [{ id: '123', messaging: [{} , { message: {} }] }] }]) assert.equal((await post(payload)).status, 400);
});
test('valid messages are receive-only and deduplicated including concurrent retry', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => post(message())));
  const bodies = await Promise.all(results.map(r => r.json()));
  assert.equal(bodies.reduce((n, b) => n + b.accepted, 0), 1);
  assert.equal(bodies.reduce((n, b) => n + b.duplicates, 0), 5);
  for (const body of bodies) { assert.equal(body.outbound, 'disabled'); assert.equal(body.processed, false); }
});
test('foreign accounts, echoes, self messages and unsupported fields never enter receipts', async () => {
  for (const payload of [message('foreign', '999'), message('echo', '123', { is_echo: true }), { object: 'instagram', entry: [{ id: '123', changes: [{ field: 'likes', value: {} }] }] }]) {
    const body = await (await post(payload)).json(); assert.equal(body.accepted, 0); assert.equal(body.ignored, 1);
  }
  const self = message('self'); self.entry[0].messaging[0].sender.id = '123';
  assert.equal((await (await post(self)).json()).accepted, 0);
});
test('comment IDs deduplicate and no provisional text rule exists', async () => {
  const payload = { object: 'instagram', entry: [{ id: '123', changes: [{ field: 'comments', value: { id: 'comment-1', text: 'قیمت', from: { id: '456' } } }] }] };
  assert.equal((await (await post(payload)).json()).accepted, 1);
  assert.equal((await (await post(payload)).json()).duplicates, 1);
});
test('methods, routes, encodings and request bounds are controlled', async () => {
  assert.equal((await fetch(await endpoint(), { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(await endpoint('/missing'))).status, 404);
  assert.equal((await post(message(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post(message(), { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await post('x'.repeat(config.maxBodyBytes + 1))).status, 413);
  const payload = { object: 'instagram', entry: Array.from({ length: 1001 }, () => ({ id: '123' })) };
  assert.equal((await post(payload)).status, 400);
});
test('health endpoints reveal no configuration or payload', async () => {
  assert.deepEqual(await (await fetch(await endpoint('/healthz'))).json(), { status: 'ok', outbound: 'disabled' });
  assert.equal((await fetch(await endpoint('/readyz'))).status, 200);
});
test('receipt persistence survives reopen and expires only after retention', () => {
  const storePath = path.join(dir, 'restart.sqlite'); let now = 100000000;
  const opts = { storePath, clock: () => now, retentionSeconds: 60, maxRecords: 2 };
  const key = 'a'.repeat(64); let s = new DedupeStore(opts);
  assert.equal(s.record([key]).accepted, 1); s.close(); s = new DedupeStore(opts);
  assert.equal(s.record([key]).duplicates, 1);
  now += 61000; assert.equal(s.record([key]).accepted, 1); s.close();
});
test('capacity failure rolls back entire batch; existing keys remain', () => {
  const s = new DedupeStore({ storePath: path.join(dir, 'capacity.sqlite'), maxRecords: 2 });
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
  s.record([a]); assert.throws(() => s.record([b, c]));
  assert.equal(s.record([b]).accepted, 1); assert.equal(s.record([a]).duplicates, 1); s.close();
});
test('storage errors return retryable 503, never a successful acknowledgement', async () => {
  const s = createServer(config, { record() { throw new Error('PRIVATE_ERROR'); }, healthy() { throw new Error('PRIVATE_ERROR'); } }, r => logs.push(r));
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  try {
    const body = JSON.stringify(message('failure'));
    const response = await fetch(`http://127.0.0.1:${s.address().port}${WEBHOOK_PATH}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', config.appSecret).update(body).digest('hex')}` } });
    assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '30');
    assert.equal((await fetch(`http://127.0.0.1:${s.address().port}/readyz`)).status, 503);
  } finally { await new Promise(resolve => s.close(resolve)); }
});
test('logs and durable receipts exclude message text, IDs and credentials', () => {
  const content = JSON.stringify(logs) + fs.readFileSync(config.storePath).toString('utf8');
  for (const secret of ['PRIVATE_SENTINEL_9471', 'PRIVATE_ERROR', 'mid-1', config.appSecret, config.verifyToken, config.dedupeKey]) assert.equal(content.includes(secret), false);
  assert.equal(fs.statSync(config.storePath).mode & 0o777, 0o600);
});

test('one event fits a limit of one and construction requires explicit safety flags', async () => {
  const { extractFingerprints } = require('./server');
  assert.equal(extractFingerprints(message('boundary'), { ...config, maxEvents: 1 }).keys.length, 1);
  const payload = message('boundary'); payload.entry[0].messaging.push(payload.entry[0].messaging[0]);
  assert.throws(() => extractFingerprints(payload, { ...config, maxEvents: 1 }));
  assert.throws(() => createServer({ ...config, receiverEnabled: false }, store));
  assert.throws(() => createServer({ ...config, outboundEnabled: true }, store));
});
test('duplicates inside one batch are atomic and keyed independently by account and kind', () => {
  const { extractFingerprints } = require('./server');
  const payload = message('same'); payload.entry[0].messaging.push(payload.entry[0].messaging[0]);
  const keys = extractFingerprints(payload, config).keys;
  const s = new DedupeStore({ storePath: path.join(dir, 'batch.sqlite') });
  assert.deepEqual(s.record(keys), { accepted: 1, duplicates: 1 });
  s.close();
  const one = extractFingerprints(message('shared'), { ...config, accountIds: ['123', '789'] }).keys[0];
  const two = extractFingerprints(message('shared', '789'), { ...config, accountIds: ['123', '789'] }).keys[0];
  assert.notEqual(one, two);
});
test('database symlinks and shared writable directories fail closed', () => {
  const link = path.join(dir, 'link.sqlite'); fs.symlinkSync(config.storePath, link);
  assert.throws(() => new DedupeStore({ storePath: link }), /symlink/);
  const shared = path.join(dir, 'shared'); fs.mkdirSync(shared, { mode: 0o700 }); fs.chmodSync(shared, 0o777);
  assert.throws(() => new DedupeStore({ storePath: path.join(shared, 'db.sqlite') }), /directory/);
  fs.chmodSync(shared, 0o700);
});
