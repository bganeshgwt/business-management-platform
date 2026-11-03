-- Up Migration
-- Time zones under their current names.
--
-- A browser names some places by their old names (its time zone data follows
-- CLDR): a computer in India reports "Asia/Calcutta", and businesses were made
-- under it. The database of a Linux server often knows only the current names
-- ("Asia/Kolkata"). There, a business under an old name could not be made (its
-- plan's start works out its day in its zone), and none of its dates could be
-- worked out. The API now keeps the current name of what a browser sends
-- (backend/src/utils/timezone.js). This migration:
--   - renames the old names already kept, for businesses and for restaurants;
--   - checks a business's zone as a restaurant's is checked (1789913000000):
--     a place name the database knows.

UPDATE businesses b SET timezone = r.current_name
FROM (VALUES
  ('asia/calcutta', 'Asia/Kolkata'), ('asia/katmandu', 'Asia/Kathmandu'), ('asia/rangoon', 'Asia/Yangon'),
  ('asia/dacca', 'Asia/Dhaka'), ('asia/thimbu', 'Asia/Thimphu'), ('asia/saigon', 'Asia/Ho_Chi_Minh'),
  ('asia/ulan_bator', 'Asia/Ulaanbaatar'), ('asia/macao', 'Asia/Macau'), ('asia/ujung_pandang', 'Asia/Makassar'),
  ('asia/chongqing', 'Asia/Shanghai'), ('asia/chungking', 'Asia/Shanghai'), ('asia/harbin', 'Asia/Shanghai'),
  ('asia/kashgar', 'Asia/Urumqi'), ('asia/tel_aviv', 'Asia/Jerusalem'), ('asia/istanbul', 'Europe/Istanbul'),
  ('europe/kiev', 'Europe/Kyiv'), ('atlantic/faeroe', 'Atlantic/Faroe'),
  ('america/buenos_aires', 'America/Argentina/Buenos_Aires'), ('america/indianapolis', 'America/Indiana/Indianapolis'),
  ('america/louisville', 'America/Kentucky/Louisville'), ('pacific/truk', 'Pacific/Chuuk'),
  ('pacific/ponape', 'Pacific/Pohnpei'), ('pacific/enderbury', 'Pacific/Kanton')
) AS r(old_name, current_name)
WHERE lower(b.timezone) = r.old_name;

UPDATE restaurant_settings s SET timezone = r.current_name
FROM (VALUES
  ('asia/calcutta', 'Asia/Kolkata'), ('asia/katmandu', 'Asia/Kathmandu'), ('asia/rangoon', 'Asia/Yangon'),
  ('asia/dacca', 'Asia/Dhaka'), ('asia/thimbu', 'Asia/Thimphu'), ('asia/saigon', 'Asia/Ho_Chi_Minh'),
  ('asia/ulan_bator', 'Asia/Ulaanbaatar'), ('asia/macao', 'Asia/Macau'), ('asia/ujung_pandang', 'Asia/Makassar'),
  ('asia/chongqing', 'Asia/Shanghai'), ('asia/chungking', 'Asia/Shanghai'), ('asia/harbin', 'Asia/Shanghai'),
  ('asia/kashgar', 'Asia/Urumqi'), ('asia/tel_aviv', 'Asia/Jerusalem'), ('asia/istanbul', 'Europe/Istanbul'),
  ('europe/kiev', 'Europe/Kyiv'), ('atlantic/faeroe', 'Atlantic/Faroe'),
  ('america/buenos_aires', 'America/Argentina/Buenos_Aires'), ('america/indianapolis', 'America/Indiana/Indianapolis'),
  ('america/louisville', 'America/Kentucky/Louisville'), ('pacific/truk', 'Pacific/Chuuk'),
  ('pacific/ponape', 'Pacific/Pohnpei'), ('pacific/enderbury', 'Pacific/Kanton')
) AS r(old_name, current_name)
WHERE lower(s.timezone) = r.old_name;

-- India's zone (every business's default) and an unchanged zone skip the
-- lookup.
CREATE FUNCTION check_business_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timezone = 'Asia/Kolkata'
     OR (TG_OP = 'UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'The time zone "%" is not a place name the database knows, such as Asia/Kolkata', NEW.timezone
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_timezone_known BEFORE INSERT OR UPDATE OF timezone ON businesses
  FOR EACH ROW EXECUTE FUNCTION check_business_timezone();

-- Down Migration
-- The old names are not put back: they are the same places, and every
-- database knows the current names.
DROP TRIGGER businesses_timezone_known ON businesses;
DROP FUNCTION check_business_timezone();
