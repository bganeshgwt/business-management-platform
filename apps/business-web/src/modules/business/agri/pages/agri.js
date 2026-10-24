import { useEffect, useState } from "react";
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
// The licence each kind of input needs at the counter (Licences & registrations).
export const LICENCE_FOR = { fertiliser: "fertiliser", seed: "seed", pesticide: "insecticide" };
export const CATEGORY_WORDS = { fertiliser: "Fertiliser", seed: "Seed", insecticide: "Insecticide" };
// How the molecule master marks a molecule.
export const MOLECULE_STATUS = {
  banned: { label: "Banned", tone: "danger" },
  restricted_use: { label: "Restricted use", tone: "warning" },
  crop_restricted: { label: "Not on some crops", tone: "info" },
};

// A name as it is compared: trimmed, single spaces, lower case.
export const normal = (text) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// An item's classification as its details keep it.
export function classOf(sku) {
  const a = sku?.attributes || {};
  return {
    kind: a.inputKind || "", subsidised: a.inputKind === "fertiliser" && a.subsidised === "yes",
    seedClass: a.seedClass || "", seedCrop: a.seedCrop || "", seedVariety: a.seedVariety || "",
    molecules: Array.isArray(a.molecules) ? a.molecules : [], formulation: a.formulation || "", netKg: a.netKg || "",
  };
}

// The molecule master and the crops it names, read once per business while the screen is open.
const loaded = new Map();
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

// The listed crop a farmer's word names (its name, an alias or its code), or null.
export function matchCrop(master, text) {
  const said = normal(text).replace(/[()]/g, "");
  if (!said || !master) return null;
  return master.crops.find((c) => [c.name, c.code.replace(/_/g, " "), ...(c.aliases || [])].some((name) => normal(name).replace(/[()]/g, "") === said)) || null;
}

// What a bill line of this item will be asked for at the counter: a PoS
// receipt (subsidised fertiliser), the crop (a molecule barred on some
// crops), and whether a listed molecule is banned or restricted.
export function lineNeeds(sku, master) {
  const item = classOf(sku);
  const listed = item.molecules.map((name) => moleculeOf(master, name)).filter(Boolean);
  return {
    kind: item.kind, subsidised: item.subsidised,
    barred: listed.filter((m) => m.status === "crop_restricted"),
    restricted: listed.filter((m) => m.status === "restricted_use"),
    banned: listed.find((m) => m.status === "banned") || null,
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
    molecules: c.molecules, formulation: c.formulation, netKg: c.netKg ? String(Number(c.netKg)) : "" };
}
// The details as the server takes them: the whole classification, its kind first.
export function agriBody(value) {
  const kind = value.inputKind;
  if (!kind) return { inputKind: "" };
  return {
    inputKind: kind,
    ...(kind === "fertiliser" && value.subsidised ? { subsidised: true } : {}),
    ...(kind === "seed" ? { seedClass: value.seedClass || undefined, seedCrop: value.seedCrop.trim() || undefined, seedVariety: value.seedVariety.trim() || undefined } : {}),
    ...(kind === "pesticide" ? { molecules: value.molecules, formulation: value.formulation.trim() || undefined } : {}),
    ...(value.netKg ? { netKg: value.netKg } : {}),
  };
}

// --- The counter's farm-input card (AgriBillFields.jsx) -----------------------------------------

// Nothing typed yet. The season's year is set when a season is chosen.
export const emptyAgriBill = () => ({ posReceipt: "", crop: "", farmerName: "", village: "", season: "", seasonYear: "", dueOn: "" });

// What the bill's lines will be asked for. lines: the counter's lines (each with its item).
export function agriNeedsOf(lines, master) {
  const each = lines.map((l) => ({ label: l.sku.label, ...lineNeeds(l.sku, master) }));
  const barred = [...new Map(each.flatMap((n) => n.barred).map((m) => [m.code, m])).values()];
  return {
    any: each.some((n) => ["fertiliser", "seed", "pesticide", "bio_input"].includes(n.kind)),
    pesticide: each.some((n) => n.kind === "pesticide"),
    subsidised: each.filter((n) => n.subsidised).map((n) => n.label),
    barred,
    restricted: [...new Map(each.flatMap((n) => n.restricted).map((m) => [m.code, m])).values()],
    banned: each.filter((n) => n.banned).map((n) => ({ label: n.label, molecule: n.banned })),
  };
}

// Why the bill cannot be taken yet ("" when it can). credit: the bill leaves money on udhaar for a customer.
export function agriProblem(needs, value, master, { credit, today }) {
  if (!needs) return "";
  if (needs.banned.length) return `${needs.banned[0].label} contains ${needs.banned[0].molecule.name}, banned in India: take it off the bill.`;
  if (needs.subsidised.length && !value.posReceipt.trim()) return "Type the PoS receipt number for the subsidised fertiliser.";
  if (needs.barred.length && !value.crop.trim()) return "Give the crop the farmer is buying the pesticide for.";
  const crop = matchCrop(master, value.crop);
  const pair = crop && needs.barred.find((m) => m.crops.some((c) => c.code === crop.code));
  if (pair) return `${pair.name} must not be used on ${crop.name.toLowerCase()}: take it off the bill, or give another crop.`;
  if (credit && value.season && (!value.seasonYear || !value.dueOn || value.dueOn < today)) return "Give the harvest date the season credit falls due (today or later).";
  return "";
}

// The bill's farm-input details as the server takes them.
export function agriBillBody(needs, value, { customer, credit }) {
  if (!needs) return {};
  const agri = {
    ...(needs.subsidised.length && value.posReceipt.trim() ? { posReceipt: value.posReceipt.trim() } : {}),
    ...(needs.any && value.crop.trim() ? { crop: value.crop.trim() } : {}),
    ...(credit && customer && value.season && value.dueOn ? { season: value.season, seasonYear: Number(value.seasonYear), dueOn: value.dueOn } : {}),
    ...(!customer && needs.any && value.village.trim() ? { village: value.village.trim() } : {}),
  };
  return Object.keys(agri).length ? { agri } : {};
}
