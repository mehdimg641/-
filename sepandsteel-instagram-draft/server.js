'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { loadConfig } = require('./config');
const { DedupeStore } = require('./store');
const WEBHOOK_PATH = '/webhooks/instagram';

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function verifyWebhookSignature(rawBody, header, appSecret) {
  if (typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return constantTimeEqual(header.slice(7).toLowerCase(), expected);
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }

function extractFingerprints(payload, config) {
  if (!object(payload) || payload.object !== 'instagram' || !Array.isArray(payload.entry)) throw new Error('Invalid payload.');
  const allowed = new Set(config.accountIds);
  const keys = [];
  let ignored = 0;
  let total = 0;
  if (payload.entry.length > config.maxEvents) throw new Error('Too many entries.');
  for (const entry of payload.entry) {
    if (!object(entry) || !identifier(entry.id)) throw new Error('Invalid entry.');
    for (const field of ['messaging', 'changes']) {
      if (entry[field] !== undefined && !Array.isArray(entry[field])) throw new Error('Invalid event list.');
      for (const event of entry[field] || []) {
        if (++total > config.maxEvents) throw new Error('Too many events.');
        if (!object(event)) throw new Error('Invalid event.');
        if (!allowed.has(entry.id)) { ignored++; continue; }
        let kind, id;
        if (field === 'messaging') {
          if (!object(event.message)) { ignored++; continue; } // read/delivery/postback: no reply behavior
          if (event.message.is_echo === true || event.sender?.id === entry.id || event.message.is_deleted === true) { ignored++; continue; }
          if (!identifier(event.message.mid) || !identifier(event.sender?.id) || event.recipient?.id !== entry.id) throw new Error('Invalid message event.');
          kind = 'message'; id = event.message.mid;
        } else {
          if (event.field !== 'comments') { ignored++; continue; }
          if (!object(event.value) || !identifier(event.value.id)) throw new Error('Invalid comment event.');
          if (event.value.from?.id === entry.id) { ignored++; continue; }
          kind = 'comment'; id = event.value.id;
        }
        keys.push(crypto.createHmac('sha256', config.dedupeKey).update(JSON.stringify([entry.id, kind, id])).digest('hex'));
      }
    }
  }
  return { keys, ignored };
}
async function readRawBody(request, limit) {
  if (request.headers['content-length'] && Number(request.headers['content-length']) > limit) {
    const error = new Error('Too large'); error.statusCode = 413; throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { const error = new Error('Too large'); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sendJson(response, statusCode, body) {
  if (response.destroyed) return;
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function safeLogger(record) { console.log(JSON.stringify(record)); }
function createHandler(config, store, logger = safeLogger) {
  if (config.receiverEnabled !== true || config.outboundEnabled !== false) throw new Error('Receiver is disabled or outbound safety guard is missing.');
  if (!config.appSecret || !config.verifyToken || !config.dedupeKey || !config.accountIds?.length || !store) throw new Error('Complete receiver configuration and store are required.');
  // Logging API only receives bounded enums/counts; no URL, IP, IDs, headers or payload.
  function log(event, counts = {}) { try { logger({ event, ...counts, outbound: 'disabled' }); } catch { /* Logging must not undo committed receipts. */ } }
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { status: 'ok', outbound: 'disabled' });
      if (request.method === 'GET' && url.pathname === '/readyz') {
        try { store.healthy(); return sendJson(response, 200, { status: 'ready', outbound: 'disabled' }); }
        catch { return sendJson(response, 503, { status: 'unavailable' }); }
      }
      if (url.pathname !== WEBHOOK_PATH) return sendJson(response, 404, { error: 'not_found' });
      if (request.method === 'GET') {
        const single = name => url.searchParams.getAll(name).length === 1;
        const challenge = url.searchParams.get('hub.challenge');
        if (!['hub.mode', 'hub.verify_token', 'hub.challenge'].every(single) || url.searchParams.get('hub.mode') !== 'subscribe' || !challenge || challenge.length > 1024 || !constantTimeEqual(url.searchParams.get('hub.verify_token') || '', config.verifyToken)) {
          return sendJson(response, 403, { error: 'verification_failed' });
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return response.end(challenge);
      }
      if (request.method !== 'POST') { response.setHeader('allow', 'GET, POST'); return sendJson(response, 405, { error: 'method_not_allowed' }); }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '') || !['identity', undefined].includes(request.headers['content-encoding'])) return sendJson(response, 415, { error: 'unsupported_media_type' });
      let rawBody;
      try { rawBody = await readRawBody(request, config.maxBodyBytes); }
      catch (error) { return sendJson(response, error.statusCode || 400, { error: 'invalid_request' }); }
      if (!verifyWebhookSignature(rawBody, request.headers['x-hub-signature-256'], config.appSecret)) { log('signature_rejected'); return sendJson(response, 401, { error: 'invalid_signature' }); }
      let extracted;
      try { extracted = extractFingerprints(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)), config); }
      catch { log('payload_rejected'); return sendJson(response, 400, { error: 'invalid_payload' }); }
      let counts;
      try { counts = store.record(extracted.keys); }
      catch { log('storage_unavailable'); response.setHeader('retry-after', '30'); return sendJson(response, 503, { error: 'storage_unavailable' }); }
      log('receipts_committed', { ...counts, ignored: extracted.ignored });
      return sendJson(response, 200, { received: true, processed: false, ...counts, ignored: extracted.ignored, outbound: 'disabled' });
    } catch { log('request_failed'); return sendJson(response, 400, { error: 'invalid_request' }); }
  };
}
function createServer(config, store, logger) {
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, createHandler(config, store, logger));
  server.maxRequestsPerSocket = 100;
  server.setTimeout(15000, socket => socket.destroy());
  return server;
}
function start(env = process.env) {
  const config = loadConfig(env);
  process.umask(0o077);
  const store = new DedupeStore(config);
  const server = createServer(config, store);
  server.on('error', () => { safeLogger({ event: 'listener_failed', outbound: 'disabled' }); process.exitCode = 1; });
  server.on('close', () => store.close());
  server.listen(config.port, config.host, () => safeLogger({ event: 'receiver_started', outbound: 'disabled' }));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 10000); timer.unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}
if (require.main === module) {
  try { start(); } catch { console.error('Startup refused: receiver disabled or configuration/storage invalid. Check README; do not print secrets.'); process.exitCode = 1; }
}
module.exports = { createServer, createHandler, verifyWebhookSignature, extractFingerprints, start, WEBHOOK_PATH };
