-- Up Migration

-- Day notes are kept, not overwritten (sweep SW-B-07).
--
-- A business day had one notes field. The opening manager's note ("float has
-- ₹500 in coins", "AC in section B broken") went into it, and closing the day
-- replaced it with whatever the closer typed — usually nothing, so the
-- morning's note was simply gone, along with who wrote it. The opening note
-- and the closing note are now kept apart; who wrote each and when are the
-- day's own opened_by/opened_at and closed_by/closed_at. `notes` stays as the
-- two together (older screens and exports read it), and a reopening still
-- adds its line there. The handover notes written during the day are the
-- shift log book's (logbook_entries, by business date and outlet).
ALTER TABLE business_days
  ADD COLUMN opening_notes VARCHAR(1000),
  -- TEXT: a close carrying many unpaid bills lists every bill number.
  ADD COLUMN closing_notes TEXT;

-- What there is for the days already kept: an open day's note can only be its
-- opening note; a closed day's note is what its close left there.
UPDATE business_days SET opening_notes = LEFT(notes, 1000)
WHERE day_status = 'open' AND notes IS NOT NULL AND notes <> '';

UPDATE business_days SET closing_notes = notes
WHERE day_status = 'closed' AND notes IS NOT NULL AND notes <> '';

-- Down Migration

ALTER TABLE business_days
  DROP COLUMN IF EXISTS closing_notes,
  DROP COLUMN IF EXISTS opening_notes;
