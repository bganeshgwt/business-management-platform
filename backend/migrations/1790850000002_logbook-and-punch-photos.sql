-- Up Migration

-- ===========================================================================
-- The shift log book, and an optional photo with each time-clock punch.
-- ===========================================================================

-- --- Shift log book -----------------------------------------------------------

-- What one shift tells the next: "walk-in freezer making noise, technician
-- coming at 11", "Table 7 regular complained about the biryani", "short of
-- paneer". One note a day (business_days.notes) was not enough, and nothing
-- said who had read it or whether it was dealt with.
--
-- Each entry is stamped with who wrote it, when, the business day and the
-- shift it was written on. needs_follow_up keeps it at the top of the log
-- (and in the bell) until someone closes it; who closed it and when are kept.
CREATE TABLE logbook_entries (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- NULL: for the whole restaurant (every outlet sees it).
  outlet_id        BIGINT        REFERENCES outlets(id),
  category         VARCHAR(20)   NOT NULL
                   CHECK (category IN ('maintenance', 'guest', 'stock', 'staff', 'other')),
  body             VARCHAR(1000) NOT NULL,
  table_id         BIGINT        REFERENCES dining_tables(id) ON DELETE SET NULL,
  -- The table's number as it was when written, so a renamed or deleted table
  -- still reads right in an old entry.
  table_label      VARCHAR(40),
  -- "Evening (17:00-01:00)": the writer's rostered shift that day, else the
  -- restaurant's shift running at the time, else the part of the day.
  shift_label      VARCHAR(100)  NOT NULL,
  business_date    DATE          NOT NULL,
  needs_follow_up  BOOLEAN       NOT NULL DEFAULT FALSE,
  closed_at        TIMESTAMPTZ,
  closed_by        BIGINT        REFERENCES users(id),
  close_note       VARCHAR(300),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       BIGINT        NOT NULL REFERENCES users(id),
  updated_by       BIGINT        REFERENCES users(id),
  CONSTRAINT chk_logbook_closed CHECK (closed_at IS NULL OR needs_follow_up),
  CONSTRAINT chk_logbook_closer CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);

-- The log, newest first, filtered by day; open follow-ups on top and in the bell.
CREATE INDEX idx_logbook_entries_restaurant ON logbook_entries (restaurant_id, created_at DESC);
CREATE INDEX idx_logbook_entries_date ON logbook_entries (restaurant_id, business_date);
CREATE INDEX idx_logbook_entries_open
  ON logbook_entries (restaurant_id, created_at) WHERE needs_follow_up AND closed_at IS NULL;

CREATE TRIGGER trg_logbook_entries_updated_at
BEFORE UPDATE ON logbook_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who has read each entry, and when: a manager coming on shift reads what
-- happened since their last one and marks it read; every entry shows who
-- has seen it.
CREATE TABLE logbook_reads (
  entry_id       BIGINT       NOT NULL REFERENCES logbook_entries(id) ON DELETE CASCADE,
  user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  read_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, user_id)
);

CREATE INDEX idx_logbook_reads_user ON logbook_reads (user_id, entry_id);

INSERT INTO permissions (code, module, name) VALUES
  ('logbook.view',  'operations', 'Read the shift log book'),
  ('logbook.write', 'operations', 'Write in the shift log book and close follow-ups');

-- Managers and cashiers keep the log book: they are the ones handing over a
-- shift. Owners and admins read and write it too.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('logbook.view', 'logbook.write')
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER', 'CASHIER');

-- A restaurant's own roles that run a shift (they open or close the business
-- day) or administer the restaurant get the log book as well, so the owner's
-- copy of Manager does not quietly lose it.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('logbook.view', 'logbook.write')
WHERE r.restaurant_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
    WHERE x.role_id = r.id
      AND xp.code IN ('business_day.manage', 'business_day.close', 'users.manage')
  )
ON CONFLICT DO NOTHING;

-- --- A photo with each punch ---------------------------------------------------

-- One person punching in for another with a shared PIN is the time clock's
-- oldest trick. With photos switched on, the tablet takes a small picture at
-- every punch; managers see it beside the punch on the day's timeline.
-- Photos are deleted automatically after photo_keep_days (60 by default).
CREATE TABLE timeclock_settings (
  restaurant_id    BIGINT       PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  punch_photos     BOOLEAN      NOT NULL DEFAULT FALSE,
  photo_keep_days  SMALLINT     NOT NULL DEFAULT 60 CHECK (photo_keep_days >= 1 AND photo_keep_days <= 365),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by       BIGINT       REFERENCES users(id),
  updated_by       BIGINT       REFERENCES users(id)
);

CREATE TRIGGER trg_timeclock_settings_updated_at
BEFORE UPDATE ON timeclock_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- With photos on: 'taken', or 'missing' when the tablet's camera could not
-- take one (the punch still counts). NULL when photos were off.
ALTER TABLE attendance_punches
  ADD COLUMN photo_status VARCHAR(10) CHECK (photo_status IN ('taken', 'missing'));

-- The picture itself, small (a 240 px square is enough to recognise someone),
-- kept in the database so it is backed up with the punches, never served as a
-- public file, and gone with the punch.
CREATE TABLE attendance_punch_photos (
  punch_id       BIGINT       PRIMARY KEY REFERENCES attendance_punches(id) ON DELETE CASCADE,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id    BIGINT       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  mime_type      VARCHAR(20)  NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/webp', 'image/png')),
  image          BYTEA        NOT NULL CHECK (octet_length(image) <= 200000),
  taken_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The clean-up deletes by age, per restaurant.
CREATE INDEX idx_attendance_punch_photos_age ON attendance_punch_photos (restaurant_id, taken_at);

-- Down Migration

DROP TABLE IF EXISTS attendance_punch_photos;
ALTER TABLE attendance_punches DROP COLUMN IF EXISTS photo_status;
DROP TABLE IF EXISTS timeclock_settings;

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('logbook.view', 'logbook.write'));
DELETE FROM permissions WHERE code IN ('logbook.view', 'logbook.write');

DROP TABLE IF EXISTS logbook_reads;
DROP TABLE IF EXISTS logbook_entries;
