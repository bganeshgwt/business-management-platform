-- Up Migration
-- A password that someone else sets for a person (a new login's first
-- password; a new one set in Users, in Staff & access or on the Platform
-- screens; the login npm run user:create makes) is changed by that person at
-- their next sign-in: until then, whoever set it could sign in as them.
-- users.password_must_change marks such a password. Its person still signs
-- in, after two-step sign-in where they use it, but the API answers every
-- request with 403 password_change_required until they choose their own,
-- except who am I (GET /api/auth/me) and changing the password
-- (POST /api/auth/change-password).
--
-- The database sets the mark, so no way of writing a password can miss it.
-- The trigger users_password_must_change marks every new password: each new
-- login, and each change of password_hash. The one exception is the person's
-- own change, which only users_set_own_password() makes (My profile, or the
-- step at sign-in, once the person has typed their current password): it
-- names the person in a setting of its own transaction, app.own_password_of,
-- and for that person alone the trigger clears the mark instead. An update
-- that leaves the password as it is changes the mark in neither direction.
--
-- Existing logins are not marked: the column comes in as FALSE on every row
-- there is, and the trigger marks only passwords written after it.

ALTER TABLE users ADD COLUMN password_must_change BOOLEAN NOT NULL DEFAULT FALSE;

-- The mark follows the password: a new one from anyone else sets it, the
-- person's own clears it, and every other change leaves it as it was.
CREATE FUNCTION users_password_must_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.password_hash IS NOT DISTINCT FROM OLD.password_hash THEN
    NEW.password_must_change := OLD.password_must_change;
  ELSE
    NEW.password_must_change := TG_OP = 'INSERT' OR COALESCE(current_setting('app.own_password_of', TRUE), '') <> NEW.id::TEXT;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_password_must_change BEFORE INSERT OR UPDATE OF password_hash, password_must_change ON users
  FOR EACH ROW EXECUTE FUNCTION users_password_must_change();

-- The person's own new password, after they typed the current one. It
-- replaces only current_hash, the password they proved, so a password someone
-- else set in the meantime is never overwritten; it ends every other session
-- (the token version) and clears the mark. Returns the new token version, or
-- NULL when the password is no longer current_hash.
CREATE FUNCTION users_set_own_password(target BIGINT, current_hash TEXT, new_hash TEXT) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE new_version INTEGER;
BEGIN
  PERFORM set_config('app.own_password_of', target::TEXT, TRUE);
  UPDATE users SET password_hash = new_hash, updated_by = target, token_version = token_version + 1
   WHERE id = target AND password_hash = current_hash
  RETURNING token_version INTO new_version;
  PERFORM set_config('app.own_password_of', '', TRUE);
  RETURN new_version;
END $$;

-- Down Migration
DROP FUNCTION users_set_own_password(BIGINT, TEXT, TEXT);
DROP TRIGGER users_password_must_change ON users;
DROP FUNCTION users_password_must_change();
ALTER TABLE users DROP COLUMN password_must_change;
