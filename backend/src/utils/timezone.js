// Time zone names as browsers report them, and as the database keeps them.
//
// A browser names some places by their old names (its time zone data follows
// CLDR, which kept them): a computer in India reports "Asia/Calcutta". The
// database of a Linux server often knows only the current names
// ("Asia/Kolkata"), so a business kept under an old name could not be made,
// and every date it asks the database for would stop. A name typed or detected
// in a browser is turned into the current one before it is checked or kept;
// migration 1791980000000 did the same for the names already kept.
const CURRENT = {
  "asia/calcutta": "Asia/Kolkata",
  "asia/katmandu": "Asia/Kathmandu",
  "asia/rangoon": "Asia/Yangon",
  "asia/dacca": "Asia/Dhaka",
  "asia/thimbu": "Asia/Thimphu",
  "asia/saigon": "Asia/Ho_Chi_Minh",
  "asia/ulan_bator": "Asia/Ulaanbaatar",
  "asia/macao": "Asia/Macau",
  "asia/ujung_pandang": "Asia/Makassar",
  "asia/chongqing": "Asia/Shanghai",
  "asia/chungking": "Asia/Shanghai",
  "asia/harbin": "Asia/Shanghai",
  "asia/kashgar": "Asia/Urumqi",
  "asia/tel_aviv": "Asia/Jerusalem",
  "asia/istanbul": "Europe/Istanbul",
  "europe/kiev": "Europe/Kyiv",
  "atlantic/faeroe": "Atlantic/Faroe",
  "america/buenos_aires": "America/Argentina/Buenos_Aires",
  "america/indianapolis": "America/Indiana/Indianapolis",
  "america/louisville": "America/Kentucky/Louisville",
  "pacific/truk": "Pacific/Chuuk",
  "pacific/ponape": "Pacific/Pohnpei",
  "pacific/enderbury": "Pacific/Kanton",
};

// The current name for a time zone name, or the name itself (trimmed) when it
// is not an old one.
const currentZone = (name) => {
  const typed = String(name ?? "").trim();
  return CURRENT[typed.toLowerCase()] || typed;
};

module.exports = { CURRENT, currentZone };
