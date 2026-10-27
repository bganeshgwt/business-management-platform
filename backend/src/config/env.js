const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// What backend/.env itself says. dotenv never overrides a variable the
// environment already has, so process.env can differ from it.
const fromEnvFile = require("dotenv").config({ quiet: true }).parsed || {};

const required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "JWT_SECRET"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// Which kind of server this is. Unset means a developer's machine. Only
// "development" and "test" (in any letter case, spaces trimmed) are treated
// as safe to run with sample settings: "production", "Production", "prod",
// "staging" or anything else a hosting panel may say is a live server, so a
// typo can never quietly switch the checks below off.
const nodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase() || "development";
const SAFE_ENVIRONMENTS = new Set(["development", "dev", "test", "local"]);
const isLive = !SAFE_ENVIRONMENTS.has(nodeEnv);

// The login secret signs every session token. Anyone who knows it can mint a
// token for any user — the platform owner included — without a password. The
// value shipped in .env.example is public, and a short or repetitive one can
// be guessed offline from a single captured token, so a live server refuses
// to start with any of them. On a developer's own machine it only warns,
// loudly, so the sample .env keeps working.
//
// Placeholders are compared on their letters and digits alone, so
// "CHANGE_ME_TO_A_LONG_RANDOM_STRING", "change-me " or "Change Me" are all
// caught.
const PLACEHOLDERS = [
  "changemetoalongrandomstring",
  "changeme",
  "secret",
  "yourjwtsecret",
  "jwtsecret",
  "yoursecret",
  "secretkey",
  "yoursecretkey",
  "supersecret",
  "mysecret",
  "password",
];
const MIN_SECRET_LENGTH = 32;
// A random secret of 32+ characters uses far more than this many different
// characters; "aaaa…" or "abababab…" does not.
const MIN_DISTINCT_CHARACTERS = 10;

const secretProblem = (raw) => {
  const secret = String(raw);
  const letters = secret.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (PLACEHOLDERS.includes(letters) || letters.includes("changeme")) {
    return "JWT_SECRET is still an example value (like the one in .env.example)";
  }

  const length = secret.trim().length;

  if (length < MIN_SECRET_LENGTH) {
    return `JWT_SECRET is only ${length} character${length === 1 ? "" : "s"} long; use at least ${MIN_SECRET_LENGTH}`;
  }

  const distinct = new Set(secret).size;

  if (distinct < MIN_DISTINCT_CHARACTERS) {
    return `JWT_SECRET repeats the same ${distinct === 1 ? "character" : `${distinct} characters`}, which is easy to guess; use a random one`;
  }

  return null;
};

const problem = secretProblem(process.env.JWT_SECRET);

if (problem) {
  const fix =
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"";

  if (isLive) {
    console.error(
      `Refusing to start (NODE_ENV=${nodeEnv}): ${problem}. Anyone who knows it can sign in as any user. ${fix}`
    );
    process.exit(1);
  }

  console.warn(
    [
      "",
      "!!! ================================================================ !!!",
      `!!!  UNSAFE LOGIN SECRET: ${problem}.`,
      "!!!  Fine on a developer machine; the server refuses to start like this",
      "!!!  unless NODE_ENV is development or test.",
      `!!!  ${fix}`,
      "!!! ================================================================ !!!",
      "",
    ].join("\n")
  );
}

// --- The guests' site's address --------------------------------------------------
//
// GUEST_WEB_URL is the guests' site's own address (apps/customer-web): where
// a link the API builds to a guest's page leads (utils/guestLinks.js) when the
// restaurant has set no guest web address of its own (Service settings). It
// is read as that address is (utils/webAddress.js). Links go to guests'
// phones, so a live server refuses to start without one they can open: https,
// and not this computer or a local network. On a developer's machine it may
// be left out (links are then built only from a restaurant's own address),
// and a mistyped one is reported and left out.
const { readWebAddress, isLocalAddress } = require("../utils/webAddress");

const WEB_ADDRESS_PROBLEMS = {
  too_long: "it is longer than 200 characters",
  not_an_address: "it is not a web address",
  not_http: "it does not start with https://",
  extra: "it has a part after a ? or #, or a login",
};

const guestWebUrl = (() => {
  const raw = process.env.GUEST_WEB_URL;
  const { address, problem } = readWebAddress(raw);
  const fix = "Set it to the guests' site's address, such as https://order.example.com.";
  const why = problem
    ? `GUEST_WEB_URL "${String(raw).trim()}" cannot be used: ${WEB_ADDRESS_PROBLEMS[problem]}`
    : !isLive
      ? null
      : !address
        ? "GUEST_WEB_URL is not set, and links sent to guests need it"
        : !address.startsWith("https://")
          ? `GUEST_WEB_URL (${address}) is not an https address`
          : isLocalAddress(address)
            ? `GUEST_WEB_URL (${address}) is a local address guests' phones cannot reach`
            : null;

  if (why && isLive) {
    console.error(`Refusing to start (NODE_ENV=${nodeEnv}): ${why}. ${fix}`);
    process.exit(1);
  }

  if (why) {
    console.warn(`${why}; it is left out. ${fix}`);
    return null;
  }

  return address;
})();

// A whole number from the environment, or the default when unset or invalid.
const intFrom = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

// --- Where uploaded files are kept ---------------------------------------------
//
// Two folders: the public one, served to anyone at /uploads (menu and product
// photos), and the private one, whose files are only ever sent through the
// API (bills on expenses and purchase bills, prescription scans, task
// photos). Each is backend/uploads or backend/private_uploads unless set; a
// relative path is taken from backend/.
const BACKEND = path.resolve(__dirname, "..", "..");

// A test run's folders are its own: one that only backend/.env names is the
// developer's, so under NODE_ENV=test it counts as not set.
const folderFrom = (name) => {
  const value = String(process.env[name] || "").trim();

  if (!value || (nodeEnv === "test" && String(fromEnvFile[name] || "").trim() === value)) {
    return null;
  }

  return path.resolve(BACKEND, value);
};

// Under NODE_ENV=test a folder left unset is a throwaway one under the
// system's temp folder, made for this process and removed when it exits, so
// no test run ever writes into a developer's folders. A process stopped
// outright (a forced kill runs no exit handler, as when the browser tests
// stop their API) leaves its folder behind; the next test process removes
// every one whose process has ended.
const TEST_FOLDER = /^rmp-test-uploads-(\d+)-/;

const processEnded = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM: the process is there, but belongs to someone else.
    return error.code !== "EPERM";
  }
};

const testFolder = () => {
  const temp = os.tmpdir();

  for (const name of fs.readdirSync(temp)) {
    const pid = Number(TEST_FOLDER.exec(name)?.[1]);

    if (pid && pid !== process.pid && processEnded(pid)) {
      try {
        fs.rmSync(path.join(temp, name), { recursive: true, force: true });
      } catch {
        // Another test process is removing it too, or a file in it is still
        // open: it goes next time.
      }
    }
  }

  const folder = fs.mkdtempSync(path.join(temp, `rmp-test-uploads-${process.pid}-`));

  process.on("exit", () => {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // Left for the next test process to remove.
    }
  });

  return folder;
};

const uploadFolders = (() => {
  const uploads = folderFrom("UPLOADS_DIR");
  const privateUploads = folderFrom("PRIVATE_UPLOADS_DIR");
  const base = nodeEnv === "test" && (!uploads || !privateUploads) ? testFolder() : BACKEND;

  return {
    uploads: uploads || path.join(base, "uploads"),
    privateUploads: privateUploads || path.join(base, "private_uploads"),
  };
})();

module.exports = {
  port: Number(process.env.PORT) || 5000,
  // The guests' site's own address (GUEST_WEB_URL, above), or null.
  guestWebUrl,
  // The staff app's address (apps/business-web), or several separated by
  // commas. The guests' site needs no entry: the public guest API answers any
  // address (app.js).
  corsOrigin: (() => {
    const origins = (process.env.CORS_ORIGIN || "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);

    return origins.length === 1 ? origins[0] : origins;
  })(),
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // How many database connections the API keeps (pg's own default, ten).
    // Requests queue for a connection and every query is short, so ten
    // carries a busy service; a larger site raises it here. Every API process
    // and tool shares PostgreSQL's limit (a hundred by default), so this is
    // not raised for everyone.
    max: intFrom("DB_POOL_MAX", 10, { min: 2, max: 200 }),
    // A request that cannot get a connection within this long fails with an
    // error instead of waiting for ever. Before, a pool that ran dry froze the
    // whole API — sign-in included — until it was restarted. The cause of
    // those freezes, a transaction asking the pool for a second connection
    // while it holds one, is what DB_POOL_GUARD (below) catches; this limit
    // is the last line of defence, so a stuck query can never take sign-in
    // down for good.
    connectionTimeoutMillis: intFrom("DB_CONNECT_TIMEOUT_MS", 15000, { min: 1000, max: 120000 }),
    // Idle connections are handed back after ten seconds (pg's default), so a
    // quiet afternoon does not hold the server's connections.
    idleTimeoutMillis: intFrom("DB_IDLE_TIMEOUT_MS", 10000, { min: 1000, max: 3600000 }),
  },
  // The hold-and-wait guard (config/database.js): "warn" logs every place
  // that asks the pool for a second connection while its transaction holds
  // one, "throw" refuses it (the tests run with it). Anything else, the
  // default, leaves the pool exactly as pg made it.
  dbPoolGuard: ["warn", "throw"].includes(String(process.env.DB_POOL_GUARD || "").trim().toLowerCase())
    ? String(process.env.DB_POOL_GUARD).trim().toLowerCase()
    : "off",
  jwt: {
    secret: process.env.JWT_SECRET,
    // How long a session lasts without being used. The screen renews the token
    // while someone is working (POST /api/auth/refresh), so a 12-hour shift is
    // never cut off mid-service; a till left untouched overnight signs out.
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
  },
  // How many FAILED sign-ins one internet address may make in fifteen minutes.
  // Successful sign-ins are not counted, so a whole shift signing in on the
  // restaurant's Wi-Fi never trips it. Guessing one person's password is
  // stopped by the per-account lockout below, so this can afford to be
  // generous; an automated test run sets it far higher.
  loginAttemptsPerQuarterHour: intFrom("LOGIN_ATTEMPT_LIMIT", 30, { min: 1 }),
  // Per-account lockout: this many wrong passwords (or wrong PINs) inside
  // lockWindowMinutes locks that one account (or PIN) for lockMinutes.
  accountLock: {
    attempts: intFrom("ACCOUNT_LOCK_ATTEMPTS", 5, { min: 1, max: 50 }),
    windowMinutes: intFrom("ACCOUNT_LOCK_WINDOW_MINUTES", 15, { min: 1, max: 1440 }),
    lockMinutes: intFrom("ACCOUNT_LOCK_MINUTES", 15, { min: 1, max: 1440 }),
  },
  // Behind a hosting proxy or load balancer every request arrives from the
  // proxy's address, so the per-address login limit would be shared by the
  // whole platform. Set TRUST_PROXY to the number of proxies in front of the
  // API (usually 1) so the real client address is used. Unset means no proxy.
  trustProxy: intFrom("TRUST_PROXY", 0, { min: 0, max: 10 }),
  // A manager approval token lives this long before it must be used.
  approvalTtlSeconds: intFrom("APPROVAL_TTL_SECONDS", 120, { min: 15, max: 900 }),
  // Live updates (modules/live): the screens' streams this API process holds
  // at most, and how many of them one login may hold in it. A screen refused
  // tries again a minute later. Each stream is an open connection to the
  // process (and through the proxy in front of it).
  live: {
    maxStreams: intFrom("LIVE_STREAMS_MAX", 2000, { min: 1, max: 100000 }),
    perPerson: intFrom("LIVE_STREAMS_PER_PERSON", 20, { min: 1, max: 1000 }),
  },
  // The public uploads folder (UPLOADS_DIR), served at /uploads, and the
  // private one (PRIVATE_UPLOADS_DIR), sent only through the API: above.
  uploadsDir: uploadFolders.uploads,
  privateUploadsDir: uploadFolders.privateUploads,
};
