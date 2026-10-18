'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

class DedupeStore {
  constructor({ storePath, retentionSeconds = 604800, maxRecords = 100000, clock = Date.now }) {
    this.clock = clock;
    this.retentionSeconds = retentionSeconds;
    this.maxRecords = maxRecords;
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(path.dirname(storePath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) || (process.getuid && parent.uid !== process.getuid())) {
      throw new Error('Database directory must be owned by this process user and not writable by other users.');
    }
    if (fs.existsSync(storePath) && fs.lstatSync(storePath).isSymbolicLink()) throw new Error('Database symlinks are not allowed.');
    this.db = new DatabaseSync(storePath);
    fs.chmodSync(storePath, 0o600);
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS receipts (fingerprint TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS receipts_expiry ON receipts(expires_at);');
  }

  // Stores only keyed fingerprints and expiry timestamps: never payloads, IDs or text.
  // All receipts in a request commit together before HTTP acknowledgement.
  record(fingerprints) {
    const now = Math.floor(this.clock() / 1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM receipts WHERE expires_at <= ?').run(now);
      const find = this.db.prepare('SELECT 1 FROM receipts WHERE fingerprint = ?');
      const insert = this.db.prepare('INSERT INTO receipts (fingerprint, expires_at) VALUES (?, ?)');
      let count = this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
      let accepted = 0;
      let duplicates = 0;
      for (const fingerprint of fingerprints) {
        if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Invalid fingerprint.');
        if (find.get(fingerprint)) { duplicates++; continue; }
        if (count >= this.maxRecords) throw new Error('Receipt capacity exhausted.');
        insert.run(fingerprint, now + this.retentionSeconds);
        count++; accepted++;
      }
      this.db.exec('COMMIT');
      return { accepted, duplicates };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve original storage failure. */ }
      throw error;
    }
  }
  healthy() { return this.db.prepare('SELECT 1 AS ok').get().ok === 1; }
  close() { this.db.close(); }
}
module.exports = { DedupeStore };
