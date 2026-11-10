const crypto = require("node:crypto");

// The API's own database login (DB_USER) does only what the API does: it
// reads and writes rows. It never builds, changes or drops a table, and it is
// never a superuser, so a bug or an injected query cannot drop the database or
// switch off the rules the database keeps (its triggers). The tables belong to
// a second login, the owner (DB_OWNER_USER), which runs the migrations and the
// backups. GO_LIVE.md › The database logins.

// Why this connection's login is too strong for a live server, or null.
async function loginProblem(db) {
  const { rows: [row] } = await db.query(`SELECT current_user AS name, r.rolsuper AS superuser,
      EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND pg_has_role(current_user, t.tableowner, 'MEMBER')) AS owner,
      has_schema_privilege(current_user, 'public', 'CREATE') AS creates
    FROM pg_roles r WHERE r.rolname = current_user`);
  if (row.superuser) return `its database login "${row.name}" is a PostgreSQL superuser`;
  if (row.owner) return `its database login "${row.name}" owns the tables, so it could change or drop them`;
  if (row.creates) return `its database login "${row.name}" may create tables`;
  return null;
}

// A live server refuses to start on a login that is too strong.
async function assertLoginFitForLive(db, { live }) {
  if (!live) return;
  const problem = await loginProblem(db);
  if (problem) {
    throw new Error(`Refusing to run a live server: ${problem}. Give the API its own login with npm run db:app-login (GO_LIVE.md › The database logins).`);
  }
}

// PostgreSQL's SCRAM-SHA-256 form of a password, made here, so the password
// itself is never sent in a statement (statements can be written to the
// server's log). Keyboard characters only: PostgreSQL normalises any other
// character (SASLprep) before hashing, which this does not repeat.
function scramVerifier(password, iterations = 4096) {
  if (typeof password !== "string" || password.length < 12 || /[^\x20-\x7e]/.test(password)) {
    throw new Error("The API's database password (DB_PASSWORD) must be at least 12 keyboard characters (letters, digits, symbols)");
  }
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest();
  const stored = crypto.createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const server = hmac(salted, "Server Key");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored.toString("base64")}:${server.toString("base64")}`;
}

// Makes the API's login, or brings it up to date: it signs in with this
// password and can do nothing beyond its own rows. `db` is a pg Client signed
// in as the owner. Refuses a name that is a superuser or owns the tables (one
// login cannot be both the owner and the API's).
async function createAppLogin(db, { name, password }) {
  const role = db.escapeIdentifier(name);
  const { rows: [existing] } = await db.query(`SELECT r.rolsuper AS superuser,
      EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = r.rolname) AS owner
    FROM pg_roles r WHERE r.rolname = $1`, [name]);
  if (existing?.superuser) throw new Error(`"${name}" is a PostgreSQL superuser: choose another name for the API's login in DB_USER`);
  if (existing?.owner) throw new Error(`"${name}" owns the tables: the API needs a login of its own in DB_USER, not the owner's`);
  const rights = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
  const secret = db.escapeLiteral(scramVerifier(password));
  await db.query(existing ? `ALTER ROLE ${role} WITH ${rights} PASSWORD ${secret}` : `CREATE ROLE ${role} WITH ${rights} PASSWORD ${secret}`);
  return { created: !existing };
}

// What the API's login may do in this database: read and write the rows of
// every table, use the sequences and functions, and nothing more. The owner
// runs it after every migration, so a new table is the API's to use at once
// (default privileges cover the tables the owner makes later too). The
// migrations' own list is read-only to the API.
async function grantAppLogin(db, { database, name }) {
  const role = db.escapeIdentifier(name);
  for (const statement of [
    `GRANT CONNECT, TEMPORARY ON DATABASE ${db.escapeIdentifier(database)} TO ${role}`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `REVOKE INSERT, UPDATE, DELETE ON pgmigrations FROM ${role}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`,
  ]) {
    await db.query(statement);
  }
}

module.exports = { loginProblem, assertLoginFitForLive, createAppLogin, grantAppLogin, scramVerifier };
