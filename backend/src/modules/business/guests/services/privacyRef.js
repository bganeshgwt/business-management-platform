const crypto = require("node:crypto");

// The reference a guest page's link to a business's privacy notice carries
// (GET /api/public/privacy/:ref, the guests' site's /privacy-notice/:ref).
//
// A guest page never names a business by its id or a slug: one could then
// list every business on the platform with its privacy contact. The
// reference is the business's id with an HMAC of it, "<id in base 36>-<22
// characters>", made with a key derived from JWT_SECRET under a label of its
// own: it is the same for the life of the business (a notice's new version
// keeps its link), and cannot be made for another business without the
// secret. A change of JWT_SECRET changes every reference; guest pages read
// theirs afresh from the business card (guestBusinessCard.js).

const REF = /^([0-9a-z]{1,11})-([A-Za-z0-9_-]{22})$/;

const deriveSecret = (secret) => Buffer.from(crypto.hkdfSync("sha256", String(secret), "bmp-guest-pages", "privacy notice reference", 32));

function refsFor(secret) {
  const key = deriveSecret(secret);
  const mac = (id) => crypto.createHmac("sha256", key).update(`business:${id}`).digest("base64url").slice(0, 22);

  // The reference of a business, by its id.
  const refOf = (businessId) => {
    const id = Number(businessId);

    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("A privacy notice reference is made for a business id");
    }

    return `${id.toString(36)}-${mac(id)}`;
  };

  // The business id a reference names, or null.
  const businessOf = (ref) => {
    const match = typeof ref === "string" ? REF.exec(ref) : null;
    const id = match ? parseInt(match[1], 36) : NaN;

    if (!Number.isSafeInteger(id) || id <= 0) {
      return null;
    }

    const expected = Buffer.from(mac(id));
    const given = Buffer.from(match[2]);

    return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? id : null;
  };

  return { refOf, businessOf };
}

// The server's own, from JWT_SECRET, made on first use.
let own = null;
const ownRefs = () => {
  const { secret } = require("../../../../config/env").jwt;

  if (!own || own.secret !== secret) {
    own = { secret, refs: refsFor(secret) };
  }

  return own.refs;
};

module.exports = {
  refsFor,
  refOf: (businessId) => ownRefs().refOf(businessId),
  businessOf: (ref) => ownRefs().businessOf(ref),
  // Where the guests' site shows a business's notice.
  pathOf: (businessId) => `/privacy-notice/${ownRefs().refOf(businessId)}`,
};
