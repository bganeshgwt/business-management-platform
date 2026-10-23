// Time-based one-time codes (RFC 6238), the six digits Google and Microsoft
// Authenticator show, written out here so no extra package is needed:
//
//   code = last 6 digits of HMAC-SHA1(secret, number of 30-second steps since 1970)
//
// Plus the two secrets the server keeps for two-step sign-in, and how they
// are kept:
//   - the authenticator secret, encrypted (AES-256-GCM) with a key from
//     TWO_FACTOR_KEY, so a copy of the database on its own cannot make codes;
//   - recovery codes, as slow salted hashes (scrypt) that need no server key
//     at all, so they still work if the server's keys ever change — they are
//     the way back in for exactly that case.
//
// TWO_FACTOR_KEY must stay the same for the life of the installation. When it
// is not set, the key is derived from JWT_SECRET (as it always was), and then
// changing JWT_SECRET would make every authenticator stop working: set
// TWO_FACTOR_KEY to today's JWT_SECRET value once, and JWT_SECRET can then be
// changed freely (see backend/.env.example).
const crypto = require("crypto");
const config = require("../config/env");

const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;

// --- Base32 (RFC 4648), the alphabet authenticator apps read ----------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }

  return out;
};

const base32Decode = (text) => {
  const clean = String(text || "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Error("not base32");
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

// --- Codes --------------------------------------------------------------------

const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

const codeFor = (secret, step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const hmac = crypto.createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
};

// The step a typed code belongs to: this 30 seconds, the one before or the
// one after (a phone a little fast or slow, or a code typed as it changed).
// null when it matches none. Compared in constant time.
const matchStep = (secret, code, ms = Date.now()) => {
  const typed = String(code || "");

  if (!new RegExp(`^\\d{${DIGITS}}$`).test(typed)) {
    return null;
  }

  const now = stepAt(ms);
  let found = null;

  for (const step of [now - 1, now, now + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(codeFor(secret, step)), Buffer.from(typed)) && found === null) {
      found = step;
    }
  }

  return found;
};

const newSecret = () => crypto.randomBytes(SECRET_BYTES);

// What the app's QR code holds: otpauth://totp/<issuer>:<account>?secret=…
const otpauthUrl = ({ secret, account, issuer }) => {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
};

// "JBSW Y3DP EHPK 3PXP …": the key typed by hand when the QR cannot be read.
const typedKey = (secret) => base32Encode(secret).replace(/(.{4})/g, "$1 ").trim();

// --- The server's keys ----------------------------------------------------------

const keyCache = new Map();
let warnedNoKey = false;

// The key material is read on every call (a cheap look-up), so the key in use
// is always the one configured now; derived keys are cached per material.
const keyMaterial = () => {
  if (process.env.TWO_FACTOR_KEY) {
    return { material: process.env.TWO_FACTOR_KEY };
  }

  if (!warnedNoKey && process.env.NODE_ENV === "production") {
    warnedNoKey = true;
    console.warn(
      "TWO_FACTOR_KEY is not set, so two-step sign-in keys are derived from JWT_SECRET. Set TWO_FACTOR_KEY to today's JWT_SECRET value before JWT_SECRET is ever changed, or every authenticator app stops working."
    );
  }

  return { material: config.jwt.secret };
};

const keyFor = (purpose) => {
  const { material } = keyMaterial();
  const cacheKey = `${purpose}\u0000${material}`;

  if (!keyCache.has(cacheKey)) {
    keyCache.set(
      cacheKey,
      Buffer.from(crypto.hkdfSync("sha256", String(material), "rmp-two-factor", `two-factor:${purpose}`, 32))
    );
  }

  return keyCache.get(cacheKey);
};

// "v1.<iv>.<tag>.<ciphertext>", each part base64url.
const encryptSecret = (secret) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor("secret"), iv);
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);

  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
};

// null when the stored value cannot be read (the key changed): the person then
// signs in with a recovery code (those need no key) and sets two-step up
// again, or an admin resets their two-step.
const decryptSecret = (stored) => {
  try {
    const [version, iv, tag, body] = String(stored || "").split(".");

    if (version !== "v1") {
      return null;
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor("secret"), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));

    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
  } catch {
    return null;
  }
};

// --- Recovery codes ---------------------------------------------------------

// No 0/O, 1/I/L: a code read off paper in a dim office must not be misread.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const newRecoveryCode = () => {
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);

  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
};

// Spaces, dashes and case do not matter when typing one back.
const normaliseRecoveryCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// A set of codes shares one random salt, kept with the person, so checking a
// typed code is one hash whatever the number of codes left.
const newRecoverySalt = () => crypto.randomBytes(16).toString("base64url");

// scrypt (16 MB, about 50 ms a code): a stolen database copy can try only a
// handful of guesses a second against codes from 31^10 possibilities, and no
// server key is involved, so changing the server's keys leaves them working.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const hashRecoveryCodeWithSalt = (code, salt) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(normaliseRecoveryCode(code), `rmp-recovery:${salt}`, 32, SCRYPT, (error, key) =>
      error ? reject(error) : resolve(key.toString("hex"))
    );
  });

// Sets made before codes were salted (no salt kept): a hash keyed with the
// server's key. Still checked, so nobody's printed codes stop working; the
// next new set uses the salted hash above.
const hashRecoveryCode = (code) =>
  crypto.createHmac("sha256", keyFor("recovery")).update(normaliseRecoveryCode(code)).digest("hex");

// The key that signs the short "password was right, now the code" ticket. It
// is not the session key, so the ticket can never be used as a session.
const challengeKey = () => keyFor("challenge").toString("hex");

module.exports = {
  base32Decode,
  stepAt,
  codeFor,
  matchStep,
  newSecret,
  otpauthUrl,
  typedKey,
  encryptSecret,
  decryptSecret,
  newRecoveryCode,
  normaliseRecoveryCode,
  newRecoverySalt,
  hashRecoveryCodeWithSalt,
  hashRecoveryCode,
  challengeKey,
};
