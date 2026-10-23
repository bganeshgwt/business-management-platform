const staffRepository = require("../repositories/staff.repository");
const { gstinState } = require("../../../../utils/gstin");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// PF, ESI and professional tax on payroll.
//
// The rules, as the PF and ESI offices apply them:
//   PF   12% from the employee and 12% from the employer, on basic wages up
//        to Rs 15,000 a month (the wage ceiling); each rounded to the nearest
//        rupee.
//   ESI  0.75% from the employee and 3.25% from the employer, on gross pay,
//        for someone whose gross pay is Rs 21,000 a month or less; each
//        rounded UP to the next rupee (ESIC rounds contributions up).
//   PT   a fixed amount a month by the state's slab table, on gross pay
//        (Maharashtra and some others charge more in February).
//
// Everything is worked out in whole paise. A pay period shorter or longer
// than a calendar month has the ceiling, the ESI limit and the professional
// tax scaled to the part of each month it covers; a whole calendar month is
// exactly the rule above. Tips, arrears carried from an earlier period and
// advances are not wages for any of the three.
//
// Off (the default), nothing changes for anyone.

// Starting slab tables, which the owner can edit (states revise them).
// `over`: monthly gross pay above this pays `amount` (the highest slab that
// applies wins); `februaryAmount` where a state collects more in February to
// make up the year's total; `for: "women"` marks a slab that applies to women
// only — a table with any such slab taxes women by those alone (and everyone
// else by the rest).
const PT_PRESETS = {
  Maharashtra: {
    slabs: [
      { over: 7500, amount: 175 },
      { over: 10000, amount: 200, februaryAmount: 300 },
      { over: 25000, amount: 200, februaryAmount: 300, for: "women" },
    ],
    note: "Women earning up to ₹25,000 a month pay nothing: set Gender to Female on their staff record and the women's slab applies.",
  },
  Karnataka: { slabs: [{ over: 24999, amount: 200, februaryAmount: 300 }] },
  Telangana: {
    slabs: [
      { over: 15000, amount: 150 },
      { over: 20000, amount: 200 },
    ],
  },
  "Andhra Pradesh": {
    slabs: [
      { over: 15000, amount: 150 },
      { over: 20000, amount: 200 },
    ],
  },
  "West Bengal": {
    slabs: [
      { over: 10000, amount: 110 },
      { over: 15000, amount: 130 },
      { over: 25000, amount: 150 },
      { over: 40000, amount: 200 },
    ],
  },
  Gujarat: { slabs: [{ over: 11999, amount: 200 }] },
  Odisha: {
    slabs: [
      { over: 13333, amount: 125 },
      { over: 25000, amount: 200, februaryAmount: 300 },
    ],
  },
  "Tamil Nadu": {
    slabs: [],
    note: "Tamil Nadu collects professional tax half-yearly. Enter the monthly amounts your consultant gives you.",
  },
  Kerala: {
    slabs: [],
    note: "Kerala collects professional tax half-yearly. Enter the monthly amounts your consultant gives you.",
  },
  Delhi: { slabs: [], none: true },
  "Uttar Pradesh": { slabs: [], none: true },
  Haryana: { slabs: [], none: true },
  Rajasthan: { slabs: [], none: true },
  Uttarakhand: { slabs: [], none: true },
  "Himachal Pradesh": { slabs: [], none: true },
  Goa: { slabs: [], none: true },
};

const DEFAULTS = {
  pfEnabled: false,
  pfEmployeeRate: 12,
  pfEmployerRate: 12,
  pfWageCeiling: 15000,
  esiEnabled: false,
  esiEmployeeRate: 0.75,
  esiEmployerRate: 3.25,
  esiWageLimit: 21000,
  ptEnabled: false,
  ptState: null,
  ptSlabs: [],
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toSettings = (row) => ({
  pfEnabled: Boolean(row.pf_enabled),
  pfEmployeeRate: Number(row.pf_employee_rate),
  pfEmployerRate: Number(row.pf_employer_rate),
  pfWageCeiling: Number(row.pf_wage_ceiling),
  esiEnabled: Boolean(row.esi_enabled),
  esiEmployeeRate: Number(row.esi_employee_rate),
  esiEmployerRate: Number(row.esi_employer_rate),
  esiWageLimit: Number(row.esi_wage_limit),
  ptEnabled: Boolean(row.pt_enabled),
  ptState: row.pt_state || null,
  ptSlabs: (row.pt_slabs || []).map((slab) => ({
    over: Number(slab.over),
    amount: Number(slab.amount),
    ...(slab.februaryAmount !== undefined && slab.februaryAmount !== null ? { februaryAmount: Number(slab.februaryAmount) } : {}),
    ...(slab.for === "women" ? { for: "women" } : {}),
  })),
  updatedAt: row.updated_at || null,
});

// The restaurant's state, from its GSTIN, so professional tax starts on the
// right table.
const stateFromGstin = async (restaurantId, db = undefined) =>
  gstinState(await staffRepository.findGstNumber(restaurantId, db));

// db: the pool, or the client of a transaction already open (payroll's
// "Mark paid").
const getSettings = async (restaurantId, db = undefined) => {
  requireRestaurantId(restaurantId);

  const row = await staffRepository.findStatutorySettings(restaurantId, db);

  if (row) {
    return { ...toSettings(row), configured: true };
  }

  // Never saved: the rules' starting values, and the slab table of the state
  // the restaurant's GSTIN is registered in.
  const state = await stateFromGstin(restaurantId, db);
  const preset = state ? PT_PRESETS[state] : null;

  return { ...DEFAULTS, ptState: state, ptSlabs: preset ? preset.slabs : [], updatedAt: null, configured: false };
};

const presets = () =>
  Object.entries(PT_PRESETS)
    .map(([state, preset]) => ({ state, slabs: preset.slabs, note: preset.note || null, none: Boolean(preset.none) }))
    .sort((a, b) => a.state.localeCompare(b.state));

const saveSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await getSettings(restaurantId);
  const slabs = [...data.ptSlabs].sort((a, b) => a.over - b.over || (a.for === "women") - (b.for === "women"));

  for (const group of [slabs.filter((slab) => slab.for !== "women"), slabs.filter((slab) => slab.for === "women")]) {
    for (let index = 1; index < group.length; index += 1) {
      if (group[index].over === group[index - 1].over) {
        throw new AppError(
          400,
          `Two professional-tax slabs${group[index].for === "women" ? " for women" : ""} both start above ₹${group[index].over}. Each slab needs its own amount.`
        );
      }
    }
  }

  const row = await staffRepository.saveStatutorySettings(restaurantId, { ...data, ptSlabs: slabs }, userId);

  return { before, after: { ...toSettings(row), configured: true } };
};

// --- The arithmetic --------------------------------------------------------------

const toPaise = (value) => Math.round(Number(value || 0) * 100);
const rupees = (paise) => round2(paise / 100);

// A rate as hundredths of a percent (12% -> 1200, 0.75% -> 75), so wages x
// rate stays a whole number and the rounding below is exact.
const basisPoints = (rate) => Math.round(Number(rate) * 100);

// wages x rate, to the nearest whole rupee (PF).
const nearestRupee = (wagesPaise, rate) => {
  const scaled = wagesPaise * basisPoints(rate);
  return Math.floor((scaled + 500000) / 1000000) * 100;
};

// wages x rate, up to the next whole rupee (ESI).
const nextRupee = (wagesPaise, rate) => {
  const scaled = wagesPaise * basisPoints(rate);
  return Math.floor((scaled + 999999) / 1000000) * 100;
};

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// How much of each calendar month a period covers: [{ month: "2026-02",
// fraction: 1 }] for 1-28 Feb 2026.
const monthShares = (from, to) => {
  const shares = [];
  let [year, month] = from.slice(0, 7).split("-").map(Number);

  for (let guard = 0; guard < 400; guard += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;

    if (key > to.slice(0, 7)) {
      break;
    }

    const last = daysInMonth(year, month);
    const start = key === from.slice(0, 7) ? Number(from.slice(8, 10)) : 1;
    const end = key === to.slice(0, 7) ? Number(to.slice(8, 10)) : last;

    shares.push({ month: key, fraction: (end - start + 1) / last, isFebruary: month === 2 });

    month += 1;

    if (month === 13) {
      month = 1;
      year += 1;
    }
  }

  return shares;
};

// Professional tax for a month's gross pay by the slab table.
const slabAmount = (monthlyGross, slabs, february) => {
  let amount = 0;

  for (const slab of [...slabs].sort((a, b) => a.over - b.over)) {
    if (monthlyGross > slab.over) {
      amount = february && slab.februaryAmount !== undefined ? slab.februaryAmount : slab.amount;
    }
  }

  return amount;
};

// The slabs that tax this person: a woman on a table with women's slabs is
// taxed by those; everyone else (and anyone whose gender is not given) by
// the general ones.
const slabsFor = (slabs, gender) => {
  const women = slabs.filter((slab) => slab.for === "women");
  return gender === "female" && women.length > 0 ? women : slabs.filter((slab) => slab.for !== "women");
};

// ESI contribution periods run 1 April to 30 September and 1 October to 31
// March. Someone covered at the start of one stays covered to its end, even
// when their gross pay later goes over the limit (a raise in July, a big
// bonus): contributions continue on their full gross until the period ends.
// The first day of the contribution period holding `date` ("YYYY-MM-DD").
const esiPeriodStart = (date) => {
  const year = Number(String(date).slice(0, 4));
  const month = Number(String(date).slice(5, 7));

  if (month >= 4 && month <= 9) {
    return `${year}-04-01`;
  }

  return month >= 10 ? `${year}-10-01` : `${year - 1}-10-01`;
};

// One person's PF, ESI and PT for a pay period.
//   person  { pfApplicable, esiApplicable, ptApplicable, basicPercent, gender,
//             esiCovered } — esiCovered: covered at the start of this ESI
//             contribution period (see esiPeriodStart), so ESI continues
//             above the limit until the period ends
//   pay     { earned, bonus } in rupees: earned is attendance pay (the wages),
//           bonus an incentive in the period (gross pay for ESI and PT)
const compute = (settings, person, pay, from, to) => {
  const none = {
    pfWages: 0,
    pfEmployee: 0,
    pfEmployer: 0,
    esiWages: 0,
    esiEmployee: 0,
    esiEmployer: 0,
    professionalTax: 0,
    esiOverLimit: false,
    esiContinued: false,
  };

  if (!settings || (!settings.pfEnabled && !settings.esiEnabled && !settings.ptEnabled)) {
    return none;
  }

  const shares = monthShares(from, to);
  const months = shares.reduce((total, share) => total + share.fraction, 0);
  const earnedPaise = toPaise(pay.earned);
  const grossPaise = earnedPaise + toPaise(pay.bonus);
  const result = { ...none };

  if (settings.pfEnabled && person.pfApplicable) {
    // Basic wages: the basic share of what attendance earned, up to the
    // ceiling for the months covered.
    const basic = Math.round((earnedPaise * Math.round(Number(person.basicPercent) * 100)) / 10000);
    const ceiling = Math.round(toPaise(settings.pfWageCeiling) * months);
    const wages = Math.min(basic, ceiling);

    result.pfWages = rupees(wages);
    result.pfEmployee = rupees(nearestRupee(wages, settings.pfEmployeeRate));
    result.pfEmployer = rupees(nearestRupee(wages, settings.pfEmployerRate));
  }

  if (settings.esiEnabled && person.esiApplicable && grossPaise > 0) {
    const limit = Math.round(toPaise(settings.esiWageLimit) * months);

    if (grossPaise <= limit || person.esiCovered) {
      result.esiWages = rupees(grossPaise);
      result.esiEmployee = rupees(nextRupee(grossPaise, settings.esiEmployeeRate));
      result.esiEmployer = rupees(nextRupee(grossPaise, settings.esiEmployerRate));
      // Over the limit, but covered since the contribution period began.
      result.esiContinued = grossPaise > limit;
    } else {
      result.esiOverLimit = true;
    }
  }

  if (settings.ptEnabled && person.ptApplicable && grossPaise > 0 && months > 0) {
    // The month's gross, for a period that is not exactly one month.
    const monthlyGross = grossPaise / 100 / months;
    const slabs = slabsFor(settings.ptSlabs, person.gender);
    let tax = 0;

    for (const share of shares) {
      tax += slabAmount(monthlyGross, slabs, share.isFebruary) * share.fraction;
    }

    result.professionalTax = Math.round(tax);
  }

  return result;
};

module.exports = {
  getSettings,
  saveSettings,
  presets,
  compute,
  esiPeriodStart,
};
