const { test } = require('node:test');
const assert = require('node:assert/strict');
const webPush = require('../src/modules/push/services/webPush');
const { phone, decrypt } = require('./integration/helpers/pushService');

// Web Push from the server with node's own crypto (modules/push/services/webPush.js):
// the message encryption checked byte for byte against RFC 8291's own example,
// VAPID tokens against RFC 8292's, and the request the server makes.

// RFC 8291, section 5 and appendix A.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  serverPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  userPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  userPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// RFC 8292, section 2.4 (Figure 1): a token and the key that signed it.
const RFC8292 = {
  token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA',
  publicKey: 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
};

test('RFC 8291: the example message, byte for byte', () => {
  const body = webPush.encrypt({
    payload: RFC8291.plaintext,
    p256dh: RFC8291.userPublic,
    auth: RFC8291.auth,
    salt: Buffer.from(RFC8291.salt, 'base64url'),
    serverPrivateKey: Buffer.from(RFC8291.serverPrivate, 'base64url'),
    recordSize: 4096,
  });
  assert.equal(body.subarray(0, 86).toString('base64url'), RFC8291.header, 'the 86-byte header: salt, record size 4096, the server\'s key');
  assert.equal(body.subarray(86).toString('base64url'), RFC8291.ciphertext, 'the record');
  assert.equal(body.toString('base64url'), RFC8291.message, 'the whole message, as in section 5');
  assert.equal(body.length, 144);

  // The phone reads it back with its own private key.
  const read = decrypt(body, { p256dh: RFC8291.userPublic, auth: RFC8291.auth, privateKey: RFC8291.userPrivate });
  assert.equal(read.text, RFC8291.plaintext);
  assert.equal(read.recordSize, 4096);
  assert.equal(read.serverPublic, RFC8291.serverPublic);
});

test('each message has a salt and a server key of its own, and only its phone reads it', () => {
  const device = phone();
  const first = webPush.encrypt({ payload: { title: 'Table 4 is calling' }, p256dh: device.p256dh, auth: device.auth });
  const second = webPush.encrypt({ payload: { title: 'Table 4 is calling' }, p256dh: device.p256dh, auth: device.auth });
  assert.notEqual(first.subarray(0, 16).toString('hex'), second.subarray(0, 16).toString('hex'), 'a fresh salt');
  assert.notEqual(first.subarray(21, 86).toString('hex'), second.subarray(21, 86).toString('hex'), 'a fresh server key');
  assert.deepEqual(JSON.parse(decrypt(first, device).text), { title: 'Table 4 is calling' });
  assert.throws(() => decrypt(first, { ...phone(), p256dh: device.p256dh, auth: device.auth }), 'another phone cannot read it');
});

test('a message holds at most 3993 bytes; bad keys are refused', () => {
  const device = phone();
  assert.equal(webPush.MAX_PAYLOAD, 3993);
  const largest = webPush.encrypt({ payload: 'x'.repeat(3993), p256dh: device.p256dh, auth: device.auth });
  assert.equal(largest.length, 4096, 'the header and one full record: what the push services take');
  assert.equal(decrypt(largest, device).text.length, 3993);
  assert.throws(() => webPush.encrypt({ payload: 'x'.repeat(3994), p256dh: device.p256dh, auth: device.auth }), /at most 3993 bytes/);
  assert.match(webPush.keysProblem({ p256dh: 'abc', auth: device.auth }), /p256dh/);
  assert.match(webPush.keysProblem({ p256dh: device.p256dh, auth: 'short' }), /auth/);
  // 65 bytes that are not a point on the curve.
  assert.match(webPush.keysProblem({ p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: device.auth }), /p256dh/);
  assert.equal(webPush.keysProblem(device), null);
});

test('RFC 8292: the example token verifies with its key, and nothing else does', () => {
  const read = webPush.verifyVapidToken(RFC8292.token, RFC8292.publicKey);
  assert.deepEqual(read.header, { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(read.claims, { aud: 'https://push.example.net', exp: 1453523768, sub: 'mailto:push@example.com' });
  const [header, claims, signature] = RFC8292.token.split('.');
  const altered = Buffer.from(JSON.stringify({ aud: 'https://push.example.net', exp: 1453523769, sub: 'mailto:push@example.com' })).toString('base64url');
  assert.equal(webPush.verifyVapidToken(`${header}.${altered}.${signature}`, RFC8292.publicKey), null, 'a changed claim');
  assert.equal(webPush.verifyVapidToken(`${header}.${claims}.${signature}`, webPush.generateKeys().publicKey), null, 'another key');
});

test('the server\'s own tokens: ES256, for one push service, under 24 hours', () => {
  const pair = webPush.generateKeys();
  assert.match(pair.publicKey, /^B[A-Za-z0-9_-]{86}$/);
  assert.match(pair.privateKey, /^[A-Za-z0-9_-]{43}$/);
  const keys = webPush.readKeys({ ...pair, subject: 'mailto:alerts@example.com' });
  const now = Date.UTC(2026, 10, 2, 12, 0, 0);
  const header = webPush.authorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', now);
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  assert.equal(match[2], pair.publicKey);
  const read = webPush.verifyVapidToken(match[1], pair.publicKey);
  assert.deepEqual(read.header, { typ: 'JWT', alg: 'ES256' });
  assert.equal(read.claims.aud, 'https://fcm.googleapis.com', 'the push service\'s origin');
  assert.equal(read.claims.sub, 'mailto:alerts@example.com');
  assert.equal(read.claims.exp, now / 1000 + 12 * 3600);
  assert.ok(read.claims.exp - now / 1000 <= 24 * 3600);
  // Kept for the same push service until an hour before it runs out, then made afresh.
  assert.equal(webPush.authorization(keys, 'https://fcm.googleapis.com/fcm/send/def', now + 3600_000), header);
  assert.notEqual(webPush.authorization(keys, 'https://fcm.googleapis.com/fcm/send/def', now + 11.5 * 3600_000), header);
  assert.notEqual(webPush.authorization(keys, 'https://web.push.apple.com/abc', now), header, 'another push service, another token');
});

test('the settings: all three, a matching pair, a subject to reach', () => {
  const pair = webPush.generateKeys();
  const other = webPush.generateKeys();
  const subject = 'mailto:alerts@example.com';
  assert.equal(webPush.vapidProblem({ ...pair, subject }), null);
  assert.equal(webPush.vapidProblem({ ...pair, subject: 'https://example.com/contact' }), null);
  assert.match(webPush.vapidProblem({ publicKey: pair.publicKey, privateKey: '', subject }), /must all be set/);
  assert.match(webPush.vapidProblem({ publicKey: other.publicKey, privateKey: pair.privateKey, subject }), /not the public half/);
  assert.match(webPush.vapidProblem({ publicKey: 'nope', privateKey: pair.privateKey, subject }), /VAPID_PUBLIC_KEY/);
  assert.match(webPush.vapidProblem({ publicKey: pair.publicKey, privateKey: 'nope', subject }), /VAPID_PRIVATE_KEY/);
  assert.match(webPush.vapidProblem({ ...pair, subject: 'alerts@example.com' }), /VAPID_SUBJECT/);
  assert.match(webPush.vapidProblem({ ...pair, subject: 'http://example.com' }), /VAPID_SUBJECT/);
  assert.throws(() => webPush.readKeys({ publicKey: other.publicKey, privateKey: pair.privateKey, subject }), /not the public half/);
});

test('addresses: only the browsers\' push services, and a pretend one on this computer in tests', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/dQw4w9', 'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://web.push.apple.com/QGuQ', 'https://wns2-pn1p.notify.windows.com/w/?token=BQYA']) {
    assert.equal(webPush.endpointProblem(ok), null, ok);
  }
  for (const bad of ['', 'not a url', 'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.example/x',
    'https://example.com/push', 'https://169.254.169.254/latest', 'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x', `https://fcm.googleapis.com/${'x'.repeat(2050)}`]) {
    assert.ok(webPush.endpointProblem(bad), bad);
  }
  assert.ok(webPush.endpointProblem('http://127.0.0.1:5000/push/a'), 'not outside tests');
  assert.equal(webPush.endpointProblem('http://127.0.0.1:5000/push/a', { allowLocal: true }), null);
  assert.ok(webPush.endpointProblem('http://10.0.0.5/push/a', { allowLocal: true }), 'a local network is never allowed');
});

test('a send: the headers the push service needs, and what its answer means', async () => {
  const pair = webPush.generateKeys();
  const keys = webPush.readKeys({ ...pair, subject: 'mailto:alerts@example.com' });
  const device = phone();
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...device };
  const calls = [];
  const answering = (status, headers = {}) => async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status, headers });
  };

  const sent = await webPush.send({ keys, subscription, payload: { title: 'Table 4 is calling', url: '/captain/calls' }, ttl: 120, urgency: 'high',
    topic: 't4call', fetchImpl: answering(201) });
  assert.deepEqual(sent, { status: 201, ok: true, gone: false, retryAfter: null });
  const [{ url, options }] = calls;
  assert.equal(url, subscription.endpoint);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(options.headers.TTL, '120');
  assert.equal(options.headers.Urgency, 'high');
  assert.equal(options.headers.Topic, 't4call');
  assert.match(options.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B[\w-]{86}$/);
  assert.deepEqual(JSON.parse(decrypt(options.body, device).text), { title: 'Table 4 is calling', url: '/captain/calls' });

  assert.deepEqual(await webPush.send({ keys, subscription, payload: 'x', fetchImpl: answering(410) }), { status: 410, ok: false, gone: true, retryAfter: null });
  assert.equal((await webPush.send({ keys, subscription, payload: 'x', fetchImpl: answering(404) })).gone, true);
  assert.deepEqual(await webPush.send({ keys, subscription, payload: 'x', fetchImpl: answering(429, { 'Retry-After': '30' }) }),
    { status: 429, ok: false, gone: false, retryAfter: 30 });
  const unreachable = await webPush.send({ keys, subscription, payload: 'x', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(unreachable, { status: 0, ok: false, gone: false, retryAfter: null });
  await assert.rejects(webPush.send({ keys, subscription, payload: 'x', topic: 'table 4 call', fetchImpl: answering(201) }), /topic/);
});
