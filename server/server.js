'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const configStore = require('./config');
const stun = require('./stun');

const config = configStore.load();
if (!config.password) {
  console.error('No provider password has been set yet. Run "npm run setup" first.');
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AUDIT_FILE = path.join(configStore.DATA_DIR, 'audit.log');

const MAX_WAITING = 25;
const MAX_MEMBERS = 8;
const MAX_SOCKETS_PER_IP = 10;
const MAX_MESSAGES_PER_10S = 400;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS_PER_IP = 5;
const LOGIN_MAX_FAILS_TOTAL = 30;
const PROVIDER_GRACE_MS = 60 * 1000;

// ---------------------------------------------------------------- audit log
// Records who-did-what for security review. Deliberately holds no client
// names and no client network addresses.
function audit(event, details) {
  const line = JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n';
  fs.appendFile(AUDIT_FILE, line, { mode: 0o600 }, (err) => {
    if (err) console.error('Could not write audit log:', err.message);
  });
}

// ------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const files = new Map();
(function loadPublic(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) loadPublic(full, `${prefix}${entry.name}/`);
    else files.set(`${prefix}${entry.name}`, { body: fs.readFileSync(full), type: MIME[path.extname(entry.name)] || 'application/octet-stream' });
  }
})(PUBLIC_DIR, '/');

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; media-src 'self' blob: mediastream:; img-src 'self' data:; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

function send(res, status, body, headers) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendFile(res, name) {
  const file = files.get(name);
  if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  send(res, 200, file.body, { 'Content-Type': file.type });
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

// ------------------------------------------------------------ request facts
function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// Behind Caddy every connection comes from this machine, so the real caller
// is the last address Caddy appended to X-Forwarded-For.
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  if (isLoopback(remote) && forwarded) return String(forwarded).split(',').pop().trim();
  return remote;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ------------------------------------------------------- provider sign-in
const sessions = new Map(); // sid -> { created, lastSeen }
const COOKIE = 'sid';

function sessionFor(req) {
  const sid = readCookie(req, COOKIE);
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  const now = Date.now();
  const expired =
    now - session.created > config.maxSessionHours * 3600 * 1000 || now - session.lastSeen > config.idleMinutes * 60 * 1000;
  if (expired) {
    sessions.delete(sid);
    audit('signin_expired');
    return null;
  }
  return { sid, session };
}

function cookieHeader(value, maxAgeSeconds) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

const loginFails = []; // { time, ip }

function loginBlocked(ip) {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  while (loginFails.length && loginFails[0].time < cutoff) loginFails.shift();
  if (loginFails.length >= LOGIN_MAX_FAILS_TOTAL) return true;
  return loginFails.filter((fail) => fail.ip === ip).length >= LOGIN_MAX_FAILS_PER_IP;
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Request refused.' });
  if (loginBlocked(ip)) {
    audit('signin_blocked', { ip });
    return sendJson(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
  }
  let password = '';
  try {
    password = JSON.parse(await readBody(req, 4096)).password;
  } catch {
    return sendJson(res, 400, { error: 'Request refused.' });
  }
  if (typeof password !== 'string' || !configStore.verifyPassword(password, config.password)) {
    loginFails.push({ time: Date.now(), ip });
    audit('signin_failed', { ip });
    return sendJson(res, 401, { error: 'Wrong password.' });
  }
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { created: Date.now(), lastSeen: Date.now() });
  audit('signin', { ip });
  send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': cookieHeader(sid, config.maxSessionHours * 3600),
  });
}

function handleLogout(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Request refused.' });
  const found = sessionFor(req);
  if (found) {
    sessions.delete(found.sid);
    audit('signout');
    endSession('signout');
    if (room.provider) room.provider.ws.close(4003, 'signed out');
  }
  send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': cookieHeader('', 0),
  });
}

// --------------------------------------------------------------------- http
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/') return sendFile(res, '/index.html');
    if (url.pathname === '/provider') {
      const found = sessionFor(req);
      if (found) found.session.lastSeen = Date.now();
      return sendFile(res, found ? '/provider.html' : '/login.html');
    }
    if (url.pathname.startsWith('/assets/')) return sendFile(res, url.pathname);
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (req.method === 'POST' && url.pathname === '/api/login') return handleLogin(req, res);
  if (req.method === 'POST' && url.pathname === '/api/logout') return handleLogout(req, res);
  send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
});

// --------------------------------------------------------------------- room
// One room. People in `waiting` are visible to the provider only and cannot
// exchange anything with anyone. People in `members` are in the live session.
const room = {
  waiting: new Map(), // id -> { id, ws, name, since }
  members: new Map(), // id -> { id, ws, name, role, state }
  provider: null, // the member entry of the connected provider
  graceTimer: null,
};

function sendTo(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function publicMember(member) {
  return { id: member.id, name: member.name, role: member.role, state: member.state };
}

function broadcast(message, exceptId) {
  for (const member of room.members.values()) if (member.id !== exceptId) sendTo(member.ws, message);
}

function pushWaitingList() {
  if (!room.provider) return;
  const list = [...room.waiting.values()].map(({ id, name, since }) => ({ id, name, since }));
  sendTo(room.provider.ws, { t: 'waiting-list', list });
}

function iceConfig() {
  const ice = { stunPort: config.stunPort || 0, turn: null };
  const turn = config.turn;
  if (turn && turn.urls && turn.secret) {
    // Short-lived TURN credentials (coturn "use-auth-secret" scheme).
    const username = `${Math.floor(Date.now() / 1000) + 6 * 3600}:telehealth`;
    const credential = crypto.createHmac('sha1', turn.secret).update(username).digest('base64');
    ice.turn = { urls: turn.urls, username, credential };
  } else if (turn && turn.urls && turn.username) {
    ice.turn = { urls: turn.urls, username: turn.username, credential: turn.credential };
  }
  return ice;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function endSession(reason) {
  for (const member of [...room.members.values()]) {
    if (member.role === 'provider') continue;
    room.members.delete(member.id);
    sendTo(member.ws, { t: 'ended' });
    member.ws.close(4000, 'session ended');
    if (room.provider) sendTo(room.provider.ws, { t: 'peer-left', id: member.id });
  }
  audit('session_ended', { reason });
}

function removeMember(id) {
  const member = room.members.get(id);
  if (!member) return;
  room.members.delete(id);
  broadcast({ t: 'peer-left', id });
  if (room.provider === member) {
    room.provider = null;
    // Give the provider a minute to come back (page refresh, brief network
    // drop) before closing the session on the clients.
    clearTimeout(room.graceTimer);
    room.graceTimer = setTimeout(() => {
      if (room.provider) return;
      endSession('provider_absent');
      for (const person of room.waiting.values()) sendTo(person.ws, { t: 'waiting' });
    }, PROVIDER_GRACE_MS);
  }
}

function joinAsProvider(ctx) {
  if (room.provider) {
    const old = room.provider;
    room.members.delete(old.id);
    room.provider = null;
    broadcast({ t: 'peer-left', id: old.id });
    sendTo(old.ws, { t: 'replaced' });
    old.ws.close(4001, 'opened elsewhere');
  }
  clearTimeout(room.graceTimer);
  const member = { id: ctx.id, ws: ctx.ws, name: config.providerName, role: 'provider', state: { audio: true, video: true, screen: false } };
  const peers = [...room.members.values()].map(publicMember);
  room.members.set(member.id, member);
  room.provider = member;
  ctx.stage = 'member';
  sendTo(ctx.ws, { t: 'hello', self: member.id, name: member.name, ice: iceConfig(), peers });
  broadcast({ t: 'peer-joined', peer: publicMember(member) }, member.id);
  pushWaitingList();
}

function handleProviderCommand(ctx, message) {
  switch (message.t) {
    case 'admit': {
      const person = room.waiting.get(message.id);
      if (!person) return;
      if (room.members.size >= MAX_MEMBERS) return sendTo(ctx.ws, { t: 'notice', text: 'The session is full.' });
      room.waiting.delete(person.id);
      const member = { id: person.id, ws: person.ws, name: person.name, role: 'client', state: { audio: true, video: true, screen: false } };
      const peers = [...room.members.values()].map(publicMember);
      room.members.set(member.id, member);
      person.ctx.stage = 'member';
      sendTo(member.ws, { t: 'admitted', self: member.id, ice: iceConfig(), peers });
      broadcast({ t: 'peer-joined', peer: publicMember(member) }, member.id);
      pushWaitingList();
      audit('admitted', { person: member.id });
      return;
    }
    case 'deny': {
      const person = room.waiting.get(message.id);
      if (!person) return;
      room.waiting.delete(person.id);
      sendTo(person.ws, { t: 'denied' });
      person.ws.close(4002, 'not admitted');
      pushWaitingList();
      audit('turned_away', { person: person.id });
      return;
    }
    case 'remove': {
      const member = room.members.get(message.id);
      if (!member || member.role === 'provider') return;
      sendTo(member.ws, { t: 'removed' });
      removeMember(member.id);
      member.ws.close(4000, 'removed');
      audit('removed', { person: member.id });
      return;
    }
    case 'end':
      endSession('provider');
      return;
    default:
  }
}

function handleMessage(ctx, message) {
  if (!message || typeof message.t !== 'string') return;

  if (ctx.stage === 'new' && ctx.role === 'client') {
    if (message.t !== 'knock') return;
    const name = cleanName(message.name);
    if (!name) return sendTo(ctx.ws, { t: 'error', text: 'Please enter your name.' });
    if (room.waiting.size >= MAX_WAITING) {
      sendTo(ctx.ws, { t: 'error', text: 'The waiting room is full. Please try again in a few minutes.' });
      return ctx.ws.close(4004, 'waiting room full');
    }
    ctx.stage = 'waiting';
    room.waiting.set(ctx.id, { id: ctx.id, ws: ctx.ws, name, since: Date.now(), ctx });
    sendTo(ctx.ws, { t: 'waiting' });
    pushWaitingList();
    audit('entered_waiting_room', { person: ctx.id });
    return;
  }

  // Everything below is only for people inside the live session.
  if (ctx.stage !== 'member') return;
  const self = room.members.get(ctx.id);
  if (!self) return;

  if (message.t === 'signal') {
    const target = room.members.get(message.to);
    if (!target || target === self || typeof message.data !== 'object' || message.data === null) return;
    return sendTo(target.ws, { t: 'signal', from: self.id, data: message.data });
  }
  if (message.t === 'state') {
    self.state = { audio: !!message.audio, video: !!message.video, screen: !!message.screen };
    return broadcast({ t: 'state', id: self.id, state: self.state }, self.id);
  }
  if (ctx.role === 'provider') handleProviderCommand(ctx, message);
}

// --------------------------------------------------------------- websockets
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const socketsPerIp = new Map();

server.on('upgrade', (req, socket, head) => {
  const refuse = (status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return refuse('404 Not Found');
  if (!sameOrigin(req)) return refuse('403 Forbidden');

  const ip = clientIp(req);
  if ((socketsPerIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) return refuse('429 Too Many Requests');

  let role = 'client';
  let sid = null;
  if (url.searchParams.get('role') === 'provider') {
    const found = sessionFor(req);
    if (!found) return refuse('401 Unauthorized');
    role = 'provider';
    sid = found.sid;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    socketsPerIp.set(ip, (socketsPerIp.get(ip) || 0) + 1);
    const ctx = { id: crypto.randomBytes(9).toString('base64url'), ws, role, sid, ip, stage: 'new', alive: true, messages: 0 };
    ws.ctx = ctx;

    ws.on('pong', () => (ctx.alive = true));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      if (++ctx.messages > MAX_MESSAGES_PER_10S) return ws.close(4005, 'too many messages');
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      handleMessage(ctx, message);
    });
    ws.on('close', () => {
      const count = (socketsPerIp.get(ip) || 1) - 1;
      if (count > 0) socketsPerIp.set(ip, count);
      else socketsPerIp.delete(ip);
      if (room.waiting.delete(ctx.id)) pushWaitingList();
      if (room.members.has(ctx.id)) {
        removeMember(ctx.id);
        if (role === 'client') audit('left', { person: ctx.id });
      }
    });
    ws.on('error', () => {});

    if (role === 'provider') joinAsProvider(ctx);
  });
});

// Every 10 seconds: drop dead connections, reset message budgets, and keep
// the provider's sign-in alive only while their page is actually open.
setInterval(() => {
  for (const ws of wss.clients) {
    const ctx = ws.ctx;
    if (!ctx) continue;
    ctx.messages = 0;
    if (ctx.role === 'provider') {
      const session = sessions.get(ctx.sid);
      const tooOld = !session || Date.now() - session.created > config.maxSessionHours * 3600 * 1000;
      if (tooOld) {
        sendTo(ws, { t: 'signed-out' });
        ws.close(4003, 'signed out');
        continue;
      }
      session.lastSeen = Date.now();
    }
    ctx.ticks = (ctx.ticks || 0) + 1;
    if (ctx.ticks % 3 === 0) {
      if (!ctx.alive) {
        ws.terminate();
        continue;
      }
      ctx.alive = false;
      ws.ping();
    }
  }
}, 10 * 1000).unref();

// -------------------------------------------------------------------- start
server.listen(config.port, config.host, () => {
  console.log(`Telehealth server listening on http://${config.host}:${config.port}`);
  console.log('Clients must reach it through HTTPS (see README: Caddy setup).');
});

if (config.stunPort) {
  stun.start(config.stunPort, (err) => console.error(`STUN server problem on UDP ${config.stunPort}: ${err.message}`));
  console.log(`STUN server listening on UDP ${config.stunPort}`);
}

audit('server_started');
