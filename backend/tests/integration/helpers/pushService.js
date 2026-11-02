const crypto = require('node:crypto');
const http = require('node:http');

// A pretend push service and pretend phones for the push tests: never a real
// push service. A phone is a P-256 key pair and a 16-byte secret, as a
// browser makes when it subscribes; the service records every message posted
// to it and answers with the status its test sets for that address (201
// unless told), and a phone reads (decrypts) what it was sent, as a browser
// does (RFC 8291, the receiving side).

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

// A phone: its keys as a subscription carries them, and its private key to read with.
const phone = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)), privateKey: ecdh.getPrivateKey() };
};

const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

// The message a phone was sent, as text: the header's salt and the server's
// one-time key, the shared secret, then the record without its delimiter.
const decrypt = (body, { p256dh, auth, privateKey }) => {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const userPublic = Buffer.from(p256dh, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey, 'base64url'));
  const secret = ecdh.computeSecret(serverPublic);
  const ikm = hkdf(Buffer.from(auth, 'base64url'), secret, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), userPublic, serverPublic]), 32);
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 2) throw new Error('The last record does not end with its delimiter');
  return { text: padded.subarray(0, end).toString('utf8'), recordSize, serverPublic: b64u(serverPublic) };
};

// The service, on a port of its own on 127.0.0.1. `received` lists every
// message ({ name, headers, body }); `answer(name, status)` sets the status
// one address answers; `endpoint(name)` is an address on it.
const start = async () => {
  const received = [];
  const answers = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const name = decodeURIComponent(req.url.replace(/^\/push\//, ''));
      received.push({ name, method: req.method, headers: req.headers, body: Buffer.concat(chunks), at: Date.now() });
      const status = answers.get(name) || 201;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status === 201 ? '' : 'gone');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    received,
    endpoint: (name) => `${origin}/push/${encodeURIComponent(name)}`,
    answer: (name, status) => answers.set(name, status),
    to: (name) => received.filter((message) => message.name === name),
    clear: () => { received.length = 0; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { phone, decrypt, start };
