'use strict';

const path = require('node:path');

function flag(env, key) {
  const value = env[key] || 'false';
  if (!['true', 'false'].includes(value)) throw new Error(`${key} must be true or false.`);
  return value === 'true';
}
function integer(env, key, fallback, min, max) {
  const raw = env[key] || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} is out of range.`);
  return value;
}
function loadConfig(env = process.env) {
  // Even an accidental opt-in must never activate sending in this release.
  if (flag(env, 'ENABLE_OUTBOUND_REPLIES')) throw new Error('Outbound replies are not implemented or approved; startup refused.');
  if (!flag(env, 'ENABLE_WEBHOOK_RECEIVER')) throw new Error('Receiver is disabled. No server was started.');
  for (const key of ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'DEDUPE_HMAC_KEY']) {
    if (!env[key] || Buffer.byteLength(env[key]) < 32 || /replace|example|placeholder/i.test(env[key])) {
      throw new Error(`${key} requires a non-placeholder secret of at least 32 bytes.`);
    }
  }
  if (new Set([env.META_APP_SECRET, env.META_VERIFY_TOKEN, env.DEDUPE_HMAC_KEY]).size !== 3) {
    throw new Error('Use distinct secrets for signing, verification and deduplication.');
  }
  const accountIds = (env.INSTAGRAM_ACCOUNT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!accountIds.length || accountIds.some(id => !/^\d{1,32}$/.test(id))) {
    throw new Error('INSTAGRAM_ACCOUNT_IDS must contain approved numeric Instagram account IDs, not usernames or Page names.');
  }
  const storePath = env.DEDUPE_DB_PATH || './data/events.sqlite';
  if (!path.isAbsolute(storePath)) throw new Error('DEDUPE_DB_PATH must be an absolute persistent-volume path.');
  return {
    receiverEnabled: true, outboundEnabled: false,
    appSecret: env.META_APP_SECRET, verifyToken: env.META_VERIFY_TOKEN,
    dedupeKey: env.DEDUPE_HMAC_KEY, accountIds, storePath,
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 3000, 1, 65535),
    maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 1048576, 1024, 4194304),
    maxEvents: integer(env, 'MAX_EVENTS_PER_REQUEST', 1000, 1, 5000),
    retentionSeconds: integer(env, 'DEDUPE_RETENTION_SECONDS', 604800, 86400, 7776000),
    maxRecords: integer(env, 'DEDUPE_MAX_RECORDS', 100000, 100, 1000000),
  };
}
module.exports = { loadConfig };
