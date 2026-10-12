-- Up Migration

-- ===========================================================================
-- Access fixes after the independent check of 2 October 2026.
-- ===========================================================================

-- 1. A sign-in ticket works once.
--
-- After the right password, a person with two-step sign-in gets a short
-- ticket ("the password was right, now the code"), good for ten minutes.
-- A ticket for setting two-step up stayed good after it had been used: sent
-- again, it put a second phone on the account, handed out a session without
-- the real owner's code, and the owner's own phone stopped working. Each
-- ticket now carries its own id, written here when the ticket is used; a
-- used id is refused. A row is only needed until its ticket would have
-- expired anyway, so expired rows are cleared as new ones are written.
CREATE TABLE user_two_factor_spent_tickets (
  ticket_id   VARCHAR(40)  PRIMARY KEY,
  user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ  NOT NULL,
  spent_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_two_factor_spent_tickets_expiry ON user_two_factor_spent_tickets (expires_at);

-- 2. Recovery codes that survive a change of the server's keys.
--
-- Recovery codes were kept as a hash keyed with the server's secret, so
-- changing that secret (a normal step after a suspected leak) made every
-- recovery code fail together with every authenticator, and an owner who
-- required two-step for admins could only be let back in by hand in the
-- database. A new set is now hashed with scrypt (slow on purpose, so a copy
-- of the database cannot be used to try codes in bulk) and a random salt kept
-- with the person, and no server key is involved. Sets made before this keep
-- working as they are until the person makes a new set.
ALTER TABLE users ADD COLUMN two_factor_recovery_salt VARCHAR(32);

-- 3. Gender on the staff record, for professional tax.
--
-- Some states tax women differently: Maharashtra exempts women earning up to
-- Rs 25,000 a month, while a man on Rs 18,000 pays Rs 200. Without a gender
-- on the record a waitress on Rs 18,000 had Rs 200 taken wrongly, and
-- switching professional tax off for her would have been wrong too once her
-- pay passes Rs 25,000. Empty means "not given": the state's general slabs
-- apply.
ALTER TABLE employees
  ADD COLUMN gender VARCHAR(10) CHECK (gender IS NULL OR gender IN ('female', 'male', 'other'));

-- Down Migration

ALTER TABLE employees DROP COLUMN IF EXISTS gender;
ALTER TABLE users DROP COLUMN IF EXISTS two_factor_recovery_salt;
DROP TABLE IF EXISTS user_two_factor_spent_tickets;
