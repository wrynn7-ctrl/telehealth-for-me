'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.TELEHEALTH_DATA || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // The web server only listens on this machine; Caddy adds HTTPS in front of it.
  host: '127.0.0.1',
  port: 3000,
  // Built-in STUN server (UDP). Set to 0 to turn it off.
  stunPort: 3478,
  // Optional TURN relay, e.g. { "urls": ["turn:example.com:3478"], "secret": "..." }
  turn: null,
  providerName: 'Provider',
  // Sign-in is dropped after this many minutes without a live provider page.
  idleMinutes: 15,
  // Sign-in never lasts longer than this, whatever happens.
  maxSessionHours: 12,
};

function load() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ...DEFAULTS, ...stored };
}

function save(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(stored.salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { DATA_DIR, CONFIG_FILE, load, save, hashPassword, verifyPassword };
