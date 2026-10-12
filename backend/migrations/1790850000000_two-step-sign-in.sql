-- Up Migration

-- ===========================================================================
-- Two-step sign-in with an authenticator app (Google or Microsoft
-- Authenticator) for owners and admins.
--
-- A password alone is one leaked sticky note away from the owner's account,
-- and the owner's account can see every rupee and change every price. With
-- two-step on, the right password gives no session: the six-digit code from
-- the person's phone is asked for as well.
-- ===========================================================================

ALTER TABLE users
  -- The shared secret behind the codes, encrypted (AES-256-GCM, key from the
  -- server's settings) so a copy of the database alone cannot make codes.
  -- No API ever returns it; it is shown once, while being set up.
  ADD COLUMN two_factor_secret      TEXT,
  ADD COLUMN two_factor_enabled_at  TIMESTAMPTZ,
  -- The 30-second step of the last code accepted. A code is accepted only for
  -- a later step, so a code read over someone's shoulder cannot be used again.
  ADD COLUMN two_factor_last_step   BIGINT,
  -- A secret being set up: it only becomes the real one when the first code
  -- from the app proves the phone has it.
  ADD COLUMN two_factor_pending     TEXT,
  ADD COLUMN two_factor_pending_at  TIMESTAMPTZ,
  ADD CONSTRAINT chk_users_two_factor CHECK ((two_factor_secret IS NULL) = (two_factor_enabled_at IS NULL));

-- Ten single-use recovery codes, for a lost or dead phone. Only a keyed hash
-- is kept (HMAC with the server's key), so a database copy cannot be used to
-- try codes offline. A new set replaces the old one.
CREATE TABLE user_recovery_codes (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash      CHAR(64)     NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, code_hash)
);

-- "How many codes are left" and spending one both read a person's unused codes.
CREATE INDEX idx_user_recovery_codes_unused ON user_recovery_codes (user_id) WHERE used_at IS NULL;

-- A remembered device (see 1789910000000) also remembers two-step:
--   two_factor_passed_at      the person passed two-step on this device. Only
--                             such a device lets someone switch to them on a
--                             shared till with their PIN.
--   two_factor_trusted_until  "Trust this device for 30 days": no code asked
--                             until then. A password change or "sign out
--                             everywhere" clears it.
ALTER TABLE user_trusted_devices
  ADD COLUMN two_factor_passed_at      TIMESTAMPTZ,
  ADD COLUMN two_factor_trusted_until  TIMESTAMPTZ;

-- The roles whose holders must use two-step, chosen by each restaurant's owner
-- (Users -> Till lock & sign-in). Someone in such a role without it is taken
-- to set it up straight after their password. Shared system roles can be
-- chosen too, so this is a list per restaurant, not a flag on the role.
CREATE TABLE restaurant_two_factor_roles (
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role_id        BIGINT       NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  PRIMARY KEY (restaurant_id, role_id)
);

-- Sign-in history says how two-step went: the code step is its own row
-- ("two_factor" or "recovery_code"), a right password still waiting for its
-- code is "code_needed", and a person sent to set two-step up is
-- "setup_needed". `two_factor` on a successful row says how the second step
-- was met (a code, a recovery code, or a device trusted for 30 days).
ALTER TABLE user_sign_ins DROP CONSTRAINT IF EXISTS user_sign_ins_method_check;
ALTER TABLE user_sign_ins
  ADD CONSTRAINT user_sign_ins_method_check
  CHECK (method IN ('password', 'pin', 'unlock', 'two_factor', 'recovery_code'));

ALTER TABLE user_sign_ins DROP CONSTRAINT IF EXISTS user_sign_ins_outcome_check;
ALTER TABLE user_sign_ins
  ADD CONSTRAINT user_sign_ins_outcome_check
  CHECK (outcome IN ('success', 'wrong_password', 'wrong_pin', 'locked', 'inactive',
                     'code_needed', 'setup_needed', 'wrong_code', 'two_factor_device'));

ALTER TABLE user_sign_ins
  ADD COLUMN two_factor VARCHAR(20)
  CHECK (two_factor IN ('passed', 'failed', 'recovery_code', 'trusted_device', 'set_up'));

-- Down Migration

ALTER TABLE user_sign_ins DROP COLUMN IF EXISTS two_factor;

DELETE FROM user_sign_ins
WHERE method IN ('two_factor', 'recovery_code')
   OR outcome IN ('code_needed', 'setup_needed', 'wrong_code', 'two_factor_device');

ALTER TABLE user_sign_ins DROP CONSTRAINT IF EXISTS user_sign_ins_outcome_check;
ALTER TABLE user_sign_ins
  ADD CONSTRAINT user_sign_ins_outcome_check
  CHECK (outcome IN ('success', 'wrong_password', 'wrong_pin', 'locked', 'inactive'));

ALTER TABLE user_sign_ins DROP CONSTRAINT IF EXISTS user_sign_ins_method_check;
ALTER TABLE user_sign_ins
  ADD CONSTRAINT user_sign_ins_method_check
  CHECK (method IN ('password', 'pin', 'unlock'));

DROP TABLE IF EXISTS restaurant_two_factor_roles;

ALTER TABLE user_trusted_devices
  DROP COLUMN IF EXISTS two_factor_trusted_until,
  DROP COLUMN IF EXISTS two_factor_passed_at;

DROP TABLE IF EXISTS user_recovery_codes;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS chk_users_two_factor,
  DROP COLUMN IF EXISTS two_factor_pending_at,
  DROP COLUMN IF EXISTS two_factor_pending,
  DROP COLUMN IF EXISTS two_factor_last_step,
  DROP COLUMN IF EXISTS two_factor_enabled_at,
  DROP COLUMN IF EXISTS two_factor_secret;
