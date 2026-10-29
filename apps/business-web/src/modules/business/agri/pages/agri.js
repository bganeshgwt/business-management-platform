import { useEffect, useMemo, useState } from "react";
import api from "../../../../services/api";
import { businessRead } from "../../../../services/business.service";

// Seeds, fertilisers & pesticides: the words and checks the farm-input
// screens, the item form and the counter share. The server makes every check
// again (agriSales.service.js); these only say ahead what it will ask for.

// A farm-input shop with its tools on.
export const usesAgri = (biz) => biz.type === "agri_inputs" && biz.has("agri");

export const INPUT_KINDS = [
  { value: "fertiliser", label: "Fertiliser" }, { value: "seed", label: "Seed" }, { value: "pesticide", label: "Pesticide" },
  { value: "bio_input", label: "Bio-input" }, { value: "other", label: "Other item" },
];
export const kindWord = (kind) => INPUT_KINDS.find((k) => k.value === kind)?.label || "";
export const SEED_CLASSES = [{ value: "certified", label: "Certified" }, { value: "truthfully_labelled", label: "Truthfully labelled" }];
export const seedClassWord = (value) => SEED_CLASSES.find((c) => c.value === value)?.label || "";
export const SEASONS = [{ value: "kharif", label: "Kharif" }, { value: "rabi", label: "Rabi" }, { value: "zaid", label: "Zaid" }];
export const seasonWord = (season, year) => (season ? `${SEASONS.find((s) => s.value === season)?.label || season}${year ? ` ${year}` : ""}` : "");
// A buyer's tags: who may buy a restricted-use pesticide, and who is a bulk consumer (Form XIII).
export const TAGS = [
  { value: "pest_control_operator", label: "Pest-control operator", reference: "Licence number" },
  { value: "government", label: "Government body", reference: "Order or authority it buys under" },
  { value: "bulk_consumer", label: "Bulk consumer", reference: "Reference (optional)" },
];
export const tagWord = (tag) => TAGS.find((t) => t.value === tag)?.label || tag;
// How season credit carries interest on what is overdue.
export const INTEREST = [
  { value: "none", label: "No interest" },
  { value: "after_due", label: "A % a month after the due date" },
  { value: "from_bill", label: "A % a month from each bill's date" },
];
export const interestWord = (season) => (season.interest === "none" ? "No interest"
  : `${Number(season.interest_rate)}% a month ${season.interest === "after_due" ? "after the due date" : "from each bill's date"}`);
// The licence each kind of input needs at the counter (Licences & registrations).
export const LICENCE_FOR = { fertiliser: "fertiliser", seed: "seed", pesticide: "insecticide" };
export const CATEGORY_WORDS = { fertiliser: "Fertiliser", seed: "Seed", insecticide: "Insecticide" };
// How the molecule master marks a molecule.
export const MOLECULE_STATUS = {
  banned: { label: "Banned", tone: "danger" },
  restricted_use: { label: "Restricted use", tone: "warning" },
  crop_restricted: { label: "Not on some crops", tone: "info" },
};
const SULPHUR = ["sulphur", "sulfur"];

// A name as it is compared: trimmed, single spaces, lower case.
export const normal = (text) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
// A formulation as it is compared: lower case, letters, digits and % only.
export const formulaKey = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9%]/g, "");

// An item's classification as its details keep it.
export function classOf(sku) {
  const a = sku?.attributes || {};
  return {
    kind: a.inputKind || "", subsidised: a.inputKind === "fertiliser" && a.subsidised === "yes",
    seedClass: a.seedClass || "", seedCrop: a.seedCrop || "", seedVariety: a.seedVariety || "",
    molecules: Array.isArray(a.molecules) ? a.molecules : [], formulation: a.formulation || "", netKg: a.netKg || "",
    approvedCrops: Array.isArray(a.approvedCrops) ? a.approvedCrops : [], household: a.inputKind === "pesticide" && a.household === "yes",
    dosePerAcre: a.dosePerAcre || "", safetyDays: a.safetyDays ?? "", ppe: a.ppe || "",
  };
}

// The molecule master and the crops the bills are matched against (the
// platform's, in their groups, with the shop's own), read once per business
// while the screen is open; `forget` drops it after the shop's crops change.
const loaded = new Map();
export const forgetMolecules = (businessId) => loaded.delete(businessId);
export function useMolecules(biz) {
  const on = usesAgri(biz);
  const [master, setMaster] = useState(() => (on ? loaded.get(biz.id) || null : null));
  useEffect(() => {
    if (!on || loaded.has(biz.id)) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "agri/molecules", undefined, controller.signal)
      .then((data) => { loaded.set(biz.id, data); setMaster(data); })
      .catch(() => {});
    return () => controller.abort();
  }, [biz.id, on]);
  return on ? master || loaded.get(biz.id) || null : null;
}
export const moleculeOf = (master, name) => master?.molecules.find((m) => normal(m.name) === normal(name)) || null;

// The crop a farmer's word names (its name, another name, or a platform crop's code), or null.
export function matchCrop(master, text) {
  const said = normal(text).replace(/[()]/g, "");
  if (!said || !master) return null;
  return master.crops.find((c) => [c.name, ...(c.code ? [c.code.replace(/_/g, " ")] : []), ...(c.aliases || [])]
    .some((name) => normal(name).replace(/[()]/g, "") === said)) || null;
}
// The codes a crop is barred through: its own and its groups'.
const cropCodes = (crop) => (crop ? [crop.code, ...(crop.groups || [])].filter(Boolean) : []);
// The molecule (of these) barred on the crop, and the crop or group it is barred on.
export function barredPair(barred, crop) {
  const codes = cropCodes(crop);
  for (const m of barred) {
    const on = m.crops.find((c) => codes.includes(c.code));
    if (on) return { molecule: m, on, through: on.code === crop.code ? null : crop.name };
  }
  return null;
}
export const pairWords = ({ molecule, on, through }) => `${molecule.name} must not be used on ${on.name.toLowerCase()}${through ? ` (${through.toLowerCase()} is one)` : ""}`;

// What a bill line of this item will be asked for at the counter: a PoS
// receipt (subsidised fertiliser), the crop (a molecule barred on some
// crops), and whether a listed molecule is banned, restricted to some users
// or allowed in one formulation only.
export function lineNeeds(sku, master) {
  const item = classOf(sku);
  const listed = item.molecules.map((name) => moleculeOf(master, name)).filter(Boolean);
  return {
    kind: item.kind, subsidised: item.subsidised,
    barred: listed.filter((m) => m.status === "crop_restricted"),
    restricted: listed.filter((m) => m.users_only && (!m.users_formulation || formulaKey(item.formulation).includes(formulaKey(m.users_formulation)))),
    banned: listed.find((m) => m.status === "banned") || null,
    sulphur: item.molecules.some((name) => SULPHUR.includes(normal(name))),
  };
}

// "a, b and c".
export const listWords = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
// "Chlorpyrifos must not be used on ber, citrus and tobacco."
export const barredWords = (molecule) => `${molecule.name} must not be used on ${listWords(molecule.crops.map((c) => c.name.toLowerCase()))}.`;

// --- The item form (AgriItemFields.jsx) ---------------------------------------------------------

// The form's values from an item's details.
export function agriFormOf(sku) {
  const c = classOf(sku);
  return { inputKind: c.kind, subsidised: c.subsidised, seedClass: c.seedClass, seedCrop: c.seedCrop, seedVariety: c.seedVariety,
    molecules: c.molecules, formulation: c.formulation, netKg: c.netKg ? String(Number(c.netKg)) : "",
    approvedCrops: c.approvedCrops, household: c.household, dosePerAcre: c.dosePerAcre, safetyDays: c.safetyDays === "" ? "" : String(c.safetyDays), ppe: c.ppe };
}
// The details as the server takes them: the whole classification, its kind first.
export function agriBody(value) {
  const kind = value.inputKind;
  if (!kind) return { inputKind: "" };
  return {
    inputKind: kind,
    ...(kind === "fertiliser" && value.subsidised ? { subsidised: true } : {}),
    ...(kind === "seed" ? { seedClass: value.seedClass || undefined, seedCrop: value.seedCrop.trim() || undefined, seedVariety: value.seedVariety.trim() || undefined } : {}),
    ...(kind === "pesticide" ? {
      molecules: value.molecules, formulation: value.formulation.trim() || undefined,
      ...(value.approvedCrops?.length ? { approvedCrops: value.approvedCrops } : {}),
      ...(value.household ? { household: true } : {}),
      ...(value.dosePerAcre?.trim() ? { dosePerAcre: value.dosePerAcre.trim() } : {}),
      ...(String(value.safetyDays ?? "").trim() ? { safetyDays: String(value.safetyDays).trim() } : {}),
      ...(value.ppe?.trim() ? { ppe: value.ppe.trim() } : {}),
    } : {}),
    ...(value.netKg ? { netKg: value.netKg } : {}),
  };
}

// --- The counter's farm-input card (AgriBillFields.jsx) -----------------------------------------

// Nothing typed yet. The season's year is set when a season is chosen;
// seasonCreditId: one of the customer's season credits ("new": a new season).
// overrides: the manager's overrides given for this bill, by kind.
export const emptyAgriBill = () => ({ posReceipt: "", crop: "", farmerName: "", village: "", seasonCreditId: "", season: "", seasonYear: "", dueOn: "", overrides: {} });

// What the bill's lines will be asked for. lines: the counter's lines (each with its item).
export function agriNeedsOf(lines, master) {
  const each = lines.map((l) => ({ label: l.sku.label, skuId: l.sku.id, ...lineNeeds(l.sku, master) }));
  const barred = [...new Map(each.flatMap((n) => n.barred).map((m) => [m.code, m])).values()];
  return {
    any: each.some((n) => ["fertiliser", "seed", "pesticide", "bio_input"].includes(n.kind)),
    pesticide: each.some((n) => n.kind === "pesticide"),
    subsidised: each.filter((n) => n.subsidised).map((n) => n.label),
    barred,
    restricted: each.filter((n) => n.restricted.length).map((n) => ({ label: n.label, skuId: n.skuId, molecules: n.restricted })),
    banned: each.filter((n) => n.banned).map((n) => ({ label: n.label, molecule: n.banned })),
    sulphur: each.filter((n) => n.sulphur).map((n) => n.label),
  };
}

// Why the bill cannot be taken yet ("" when it can). credit: the bill leaves money on udhaar for a customer.
export function agriProblem(needs, value, master, { credit, today, customer }) {
  if (!needs) return "";
  if (needs.banned.length) return `${needs.banned[0].label} contains ${needs.banned[0].molecule.name}, banned in India: take it off the bill.`;
  if (needs.subsidised.length && !value.posReceipt.trim()) return "Type the PoS receipt number for the subsidised fertiliser.";
  if (needs.barred.length && !value.crop.trim()) return "Give the crop the farmer is buying the pesticide for.";
  const pair = barredPair(needs.barred, matchCrop(master, value.crop));
  if (pair) return `${pairWords(pair)}: take it off the bill, or give another crop.`;
  if (needs.sulphur.length && !customer && (!value.farmerName.trim() || !value.village.trim())) return "Sulphur is sold with the buyer's name and village: type them.";
  if (credit && value.seasonCreditId === "new" && (!value.season || !value.seasonYear || !value.dueOn || value.dueOn < today)) {
    return "Give the season and the harvest date its credit falls due (today or later).";
  }
  return "";
}

// The first of the counter's notes the bill would be refused for, unless a
// manager's override given for this bill covers it (null: none).
export const stopOf = (notes, overrides = {}) => notes.find((n) => n.level === "stop" && !(n.override && overrides[n.override])) || null;

// The counter's checks of the lines being typed, as the bill will make them
// (POST agri/counter-check): `notes`, each { skuId?, label?, kind, level:
// "stop" | "warn", message, override? }; `bags` ({ before, after, limit }, a
// named farmer's subsidised bags this month); `tags` (the customer's tags in
// force). Asked a moment after the till, the customer, the lines or the crop
// change; a newer question cancels the older one, and a question that fails
// gives no notes. lines: [{ skuId, quantity (stock units), crop? }].
const NO_CHECKS = Object.freeze({ notes: Object.freeze([]), bags: null, tags: Object.freeze([]) });
export function useCounterChecks(biz, { locationId, contactId, lines, crop }) {
  const on = usesAgri(biz);
  const asked = on ? (lines || []).filter((l) => Number.isSafeInteger(Number(l.skuId)) && Number(l.skuId) > 0).slice(0, 100)
    .map((l) => ({ skuId: Number(l.skuId), ...(Number(l.quantity) > 0 ? { quantity: String(l.quantity) } : {}), ...(l.crop ? { crop: l.crop } : {}) })) : [];
  // The question as one string, so a new render with the same lines asks nothing again.
  const scope = JSON.stringify([biz.id, locationId ? String(locationId) : "", contactId ? String(contactId) : ""]);
  const key = on && locationId && asked.length ? JSON.stringify([scope, asked, crop ? crop.trim() : ""]) : "";
  const [answer, setAnswer] = useState({ key: "", scope: "", data: NO_CHECKS });
  useEffect(() => {
    if (!key) return undefined;
    const [question, list, said] = JSON.parse(key);
    const [businessId, location, contact] = JSON.parse(question);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.post(`/businesses/${businessId}/agri/counter-check`, { locationId: location, ...(contact ? { contactId: contact } : {}), ...(said ? { crop: said } : {}), lines: list },
        { signal: controller.signal })
        .then((response) => { if (!controller.signal.aborted) setAnswer({ key, scope: question, data: response.data.data || NO_CHECKS }); })
        .catch(() => { if (!controller.signal.aborted) setAnswer({ key, scope: question, data: NO_CHECKS }); });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return useMemo(() => {
    if (!key) return NO_CHECKS;
    const [question, list] = JSON.parse(key);
    // Until the new answer comes, the last one's notes for the items still on the bill, at the same till for the same customer.
    if (answer.key === key) return { notes: answer.data.notes || [], bags: answer.data.bags || null, tags: answer.data.tags || [] };
    if (answer.scope !== question) return NO_CHECKS;
    const ids = list.map((l) => l.skuId);
    return { notes: (answer.data.notes || []).filter((n) => !n.skuId || ids.includes(Number(n.skuId))), bags: answer.data.bags || null, tags: answer.data.tags || [] };
  }, [key, answer]);
}

// A customer's season credits still open, for the counter's season choice
// and a quotation's bill. null while asked.
export function useOpenSeasons(biz, contactId) {
  const on = usesAgri(biz) && Boolean(contactId);
  const [state, setState] = useState({ key: "", seasons: [] });
  const key = on ? `${biz.id}:${contactId}` : "";
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "agri/season-credits", { contact: contactId, closed: "false", limit: 50 }, controller.signal)
      .then((page) => setState({ key, seasons: page.items }))
      .catch(() => { if (!controller.signal.aborted) setState({ key, seasons: [] }); });
    return () => controller.abort();
  }, [biz.id, contactId, key]);
  return key ? (state.key === key ? state.seasons : null) : [];
}

// The bill's farm-input details as the server takes them.
export function agriBillBody(needs, value, { customer, credit }) {
  if (!needs) return {};
  const overrideIds = Object.values(value.overrides || {}).map((o) => o.id);
  const season = credit && customer && value.seasonCreditId
    ? (value.seasonCreditId === "new" ? (value.season && value.dueOn ? { season: value.season, seasonYear: Number(value.seasonYear), dueOn: value.dueOn } : {})
      : { seasonCreditId: Number(value.seasonCreditId) }) : {};
  const agri = {
    ...(needs.subsidised.length && value.posReceipt.trim() ? { posReceipt: value.posReceipt.trim() } : {}),
    ...(needs.any && value.crop.trim() ? { crop: value.crop.trim() } : {}),
    ...season,
    ...(!customer && needs.any && value.village.trim() ? { village: value.village.trim() } : {}),
    ...(overrideIds.length ? { overrideIds } : {}),
  };
  return Object.keys(agri).length ? { agri } : {};
}
