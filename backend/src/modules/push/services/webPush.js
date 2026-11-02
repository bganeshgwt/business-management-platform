const crypto = require('node:crypto');

// Web Push from this server, with nothing but node's own crypto and fetch
// (ARCHITECTURE.md › Alerts on a closed phone):
//
//   - VAPID (RFC 8292): each request carries a short token the server signs
//     with its private key (ES256), naming the push service it is for (aud),
//     when it stops working (exp, under 24 hours) and whom to contact (sub);
//     the push service checks it against the public key the browser
//     subscribed with.
//   - Message encryption (RFC 8291, aes128gcm): the message is encrypted for
//     the phone's own key, so the push service carries it without reading it.
//   - The request (RFC 8030): TTL (how long the push service keeps it for a
//     phone that is off), Urgency (high wakes a sleeping phone), and Topic (a
//     newer message of the same topic replaces one still waiting).
//
// Pure: no database, no settings read at load, so the unit tests can run it
// on the RFCs' own examples. Keys travel as base64url text: the public key is
// the uncompressed P-256 point (65 bytes), the private key its 32-byte d.
// Nothing here logs; a key, a subscription's address or its secret never
// leaves this module except in the request to the push service itself.

const KEY_INFO = Buffer.from('WebPush: info\0', 'latin1');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'latin1');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'latin1');
// One record holds the whole message: the push services take 4096 bytes in all.
const RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
const TAG_BYTES = 16;
// The most a message may hold: a record less its header, tag and delimiter.
const MAX_PAYLOAD = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;
// A token is made for 12 hours (the limit is 24) and used until an hour before it runs out.
const TOKEN_HOURS = 12;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

// Base64url text of exactly `size` bytes, or null.
const bytesOf = (text, size) => {
  const value = String(text || '').trim();
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === size && b64u(bytes) === value ? bytes : null;
};

const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

// A P-256 public key (65 bytes, uncompressed) as a key object, or null when
// it is not a point on the curve.
const publicKeyObject = (point) => {
  if (!point || point.length !== 65 || point[0] !== 4) return null;
  try {
    return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: 'jwk' });
  } catch {
    return null;
  }
};

// --- The server's keys (VAPID) ----------------------------------------------

// A new key pair for VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (npm run push:keys).
const generateKeys = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const point = publicKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(point.x, 'base64url'), Buffer.from(point.y, 'base64url')])),
    privateKey: privateKey.export({ format: 'jwk' }).d,
  };
};

// What is wrong with the three settings, in words for the person setting up
// the server; null when they work together.
const vapidProblem = ({ publicKey, privateKey, subject }) => {
  const point = bytesOf(publicKey, 65);
  const secret = bytesOf(privateKey, 32);
  if (!publicKey || !privateKey || !subject) return 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must all be set (npm run push:keys makes the keys)';
  if (!point || !publicKeyObject(point)) return 'VAPID_PUBLIC_KEY is not a P-256 public key in base64url (npm run push:keys makes one)';
  if (!secret) return 'VAPID_PRIVATE_KEY is not a P-256 private key in base64url (npm run push:keys makes one)';
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(secret);
    if (!ecdh.getPublicKey().equals(point)) return 'VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY: copy both from one run of npm run push:keys';
  } catch {
    return 'VAPID_PRIVATE_KEY is not a P-256 private key in base64url (npm run push:keys makes one)';
  }
  if (!/^mailto:[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(subject) && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(subject)) {
    return 'VAPID_SUBJECT must be a mailto: address (mailto:alerts@example.com) or an https:// address the push services can reach you at';
  }
  return null;
};

// The keys ready to sign with. Throws on keys vapidProblem refuses.
const readKeys = ({ publicKey, privateKey, subject }) => {
  const problem = vapidProblem({ publicKey, privateKey, subject });
  if (problem) throw new Error(problem);
  const point = bytesOf(publicKey, 65);
  const signing = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)), d: privateKey }, format: 'jwk',
  });
  return { publicKey, subject, signing, tokens: new Map() };
};

// The VAPID token for one push service (`audience`, its origin), valid until `expiresAt` (seconds).
const vapidToken = ({ audience, subject, signing, expiresAt }) => {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: expiresAt, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: signing, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(signature)}`;
};

// Whether `token` is a VAPID token signed with the private half of
// `publicKey`; its claims when it is, else null. For the tests and the
// pretend push service they run.
const verifyVapidToken = (token, publicKey) => {
  const parts = String(token || '').split('.');
  const key = publicKeyObject(bytesOf(publicKey, 65));
  if (parts.length !== 3 || !key) return null;
  const good = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
  if (!good) return null;
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')) };
  } catch {
    return null;
  }
};

// The Authorization header for a request to `endpoint`, reusing a token made
// for its push service until an hour before it runs out.
const authorization = (keys, endpoint, now = Date.now()) => {
  const audience = new URL(endpoint).origin;
  const seconds = Math.floor(now / 1000);
  const kept = keys.tokens.get(audience);
  if (kept && kept.expiresAt - 3600 > seconds) return `vapid t=${kept.token}, k=${keys.publicKey}`;
  const expiresAt = seconds + TOKEN_HOURS * 3600;
  const token = vapidToken({ audience, subject: keys.subject, signing: keys.signing, expiresAt });
  keys.tokens.set(audience, { token, expiresAt });
  return `vapid t=${token}, k=${keys.publicKey}`;
};

// --- The message (RFC 8291) ------------------------------------------------------

// What is wrong with a subscription's keys, or null: p256dh the phone's
// public key (65 bytes), auth its secret (16 bytes), both base64url.
const keysProblem = ({ p256dh, auth }) => {
  if (!publicKeyObject(bytesOf(p256dh, 65))) return 'The subscription\'s p256dh is not a P-256 public key in base64url';
  if (!bytesOf(auth, 16)) return 'The subscription\'s auth is not a 16-byte secret in base64url';
  return null;
};

// The message encrypted for one phone: salt, record size, the server's
// one-time public key, then the record. `salt` and `serverPrivateKey` are
// random unless given (the RFC's example gives both).
const encrypt = ({ payload, p256dh, auth, salt = crypto.randomBytes(16), serverPrivateKey = null, recordSize = RECORD_SIZE }) => {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  if (plaintext.length > MAX_PAYLOAD) throw new Error(`A push message holds at most ${MAX_PAYLOAD} bytes; this one is ${plaintext.length}`);
  const problem = keysProblem({ p256dh, auth });
  if (problem) throw new Error(problem);
  if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new Error('The salt must be 16 bytes');
  const userPublic = bytesOf(p256dh, 65);
  const authSecret = bytesOf(auth, 16);
  const ecdh = crypto.createECDH('prime256v1');
  if (serverPrivateKey) ecdh.setPrivateKey(Buffer.isBuffer(serverPrivateKey) ? serverPrivateKey : Buffer.from(serverPrivateKey, 'base64url'));
  else ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(userPublic);
  const ikm = hkdf(authSecret, secret, Buffer.concat([KEY_INFO, userPublic, serverPublic]), 32);
  const key = hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = hkdf(salt, ikm, NONCE_INFO, 12);
  // The last (and only) record: the message, then its delimiter, 0x02.
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(65, 20);
  serverPublic.copy(header, 21);
  return Buffer.concat([header, record]);
};

// --- Sending ---------------------------------------------------------------------

// The push services this server sends to: Chrome, Edge (Windows) and Samsung
// Internet's, Firefox's, and Safari's (iPhone and Mac). A subscription to any
// other address is refused, so the server never posts to a place a browser
// did not choose. Under NODE_ENV=test a pretend one on this computer is
// allowed too.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/];

// What is wrong with a subscription's address, or null.
const endpointProblem = (endpoint, { allowLocal = false } = {}) => {
  const text = String(endpoint || '');
  if (!text || text.length > 2048) return 'The subscription\'s address is missing or too long';
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'The subscription\'s address is not a web address';
  }
  if (url.username || url.password || url.hash) return 'The subscription\'s address is not a push service\'s';
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (allowLocal && local && ['http:', 'https:'].includes(url.protocol)) return null;
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !PUSH_HOSTS.some((host) => host.test(url.hostname))) {
    return 'This browser\'s push service is not one this server sends alerts through';
  }
  return null;
};

// Sends one message to one subscription. Resolves { status, ok, gone,
// retryAfter } (status 0 when the push service could not be reached); never
// throws for the push service's answer.
//   ttl       seconds the push service keeps it for a phone that is off
//   urgency   very-low, low, normal or high
//   topic     a newer message of the same topic replaces one still waiting
const send = async ({ keys, subscription, payload, ttl = 60, urgency = 'high', topic = null, fetchImpl = fetch, timeoutMs = 10000, now = Date.now() }) => {
  const body = encrypt({ payload, p256dh: subscription.p256dh, auth: subscription.auth });
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(Math.max(0, Math.floor(ttl))),
    Urgency: urgency,
    Authorization: authorization(keys, subscription.endpoint, now),
  };
  if (topic) {
    if (!TOPIC.test(topic)) throw new Error('A topic is 1 to 32 letters, digits, - or _');
    headers.Topic = topic;
  }
  try {
    const response = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    // The answer's body says nothing the server needs; it is read and dropped.
    await response.arrayBuffer().catch(() => null);
    const retry = Number(response.headers.get('retry-after'));
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      gone: response.status === 404 || response.status === 410,
      retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null,
    };
  } catch {
    return { status: 0, ok: false, gone: false, retryAfter: null };
  }
};

module.exports = {
  MAX_PAYLOAD,
  RECORD_SIZE,
  generateKeys,
  vapidProblem,
  readKeys,
  vapidToken,
  verifyVapidToken,
  authorization,
  keysProblem,
  encrypt,
  endpointProblem,
  send,
};
