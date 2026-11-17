'use strict';
// Minimal STUN server (RFC 5389 Binding requests only).
// Browsers ask it "what is my public address?" so two people behind home
// routers can connect directly. It never sees audio, video or names.
const dgram = require('dgram');

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

function buildResponse(request, remote) {
  if (request.length < 20) return null;
  if (request.readUInt16BE(0) !== BINDING_REQUEST) return null;
  if (request.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  if (request.readUInt16BE(2) + 20 !== request.length) return null;

  const parts = remote.address.split('.').map(Number);
  if (parts.length !== 4) return null;
  const address = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;

  const response = Buffer.alloc(32);
  response.writeUInt16BE(BINDING_SUCCESS, 0);
  response.writeUInt16BE(12, 2);
  request.copy(response, 4, 4, 20); // magic cookie + transaction id
  response.writeUInt16BE(XOR_MAPPED_ADDRESS, 20);
  response.writeUInt16BE(8, 22);
  response.writeUInt8(0x01, 25); // IPv4
  response.writeUInt16BE(remote.port ^ (MAGIC_COOKIE >>> 16), 26);
  response.writeUInt32BE((address ^ MAGIC_COOKIE) >>> 0, 28);
  return response;
}

function start(port, onError) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, remote) => {
    const response = buildResponse(message, remote);
    if (response) socket.send(response, remote.port, remote.address);
  });
  socket.on('error', (err) => onError && onError(err));
  socket.bind(port);
  return socket;
}

module.exports = { start, buildResponse };
