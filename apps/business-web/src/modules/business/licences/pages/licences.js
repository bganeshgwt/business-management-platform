import api, { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { dateShort } from "@bmp/shared/format";
import { CATEGORY_WORDS } from "../../agri/pages/agri";

// Licences & registrations: the words, states and file helpers the list
// (LicencesPage.jsx) and one licence's detail (LicenceDetail.jsx) share. The
// server works out where each licence stands; these only put it in words.

// Where a licence stands on the business's own date.
export const STATES = {
  valid: { label: "Valid", tone: "success" }, no_expiry: { label: "No expiry", tone: "success" }, expiring: { label: "Runs out soon", tone: "warning" },
  expired: { label: "Run out", tone: "danger" }, not_yet: { label: "Not yet valid", tone: "info" }, off: { label: "Switched off", tone: "neutral" },
  // Past its date, and still in force while the renewal applied for is pending.
  renewal_pending: { label: "In force: renewal pending", tone: "warning" },
};
export const stateOf = (licence) => STATES[licence.state] || { label: licence.state, tone: "neutral" };

// "12 days left", "Last day", "Ran out 3 days ago"; past its date but in force: "Past its date by 3 days".
export const daysWords = (n, state) => {
  if (n === null || n === undefined) return "";
  const days = (count) => `${count} day${count === 1 ? "" : "s"}`;
  if (n < 0) return state === "renewal_pending" ? `Past its date by ${days(-n)}` : `Ran out ${days(-n)} ago`;
  return n === 0 ? "Last day" : `${days(n)} left`;
};

// The kind of licence, as the platform names it.
export const kindName = (licence) => licence.kind_name || (licence.kind === "other" ? "Other licence" : licence.kind);

// The kinds a new licence may be: those offered to this trade (its own first,
// as the server lists them), then a licence of any other name.
export const OTHER_KIND = { code: "other", name: "", covers: [], sells_to: "both" };
export const offeredKinds = (rows) => [...(rows || []).filter((k) => k.offered && k.code !== OTHER_KIND.code), OTHER_KIND];

// Who a licence lets the location sell to. A buyer with a GSTIN (a B2B invoice) buys wholesale.
export const SELLS_TO = [
  { value: "retail", label: "Retail", words: "Retail sales only" },
  { value: "wholesale", label: "Wholesale", words: "Wholesale sales only" },
  { value: "both", label: "Both", words: "Retail and wholesale sales" },
];
export const sellsToWords = (value) => SELLS_TO.find((s) => s.value === value)?.words || "";
export const coversWords = (covers) => (covers || []).map((c) => CATEGORY_WORDS[c] || c).join(", ");

// The qualified person the licence names, as written on it: their
// qualification (with its certificate's number), or why they are exempt.
export const qualifiedWords = (licence) => [
  licence.qualified_person,
  licence.qualification && (licence.qualification_certificate ? `${licence.qualification}, certificate ${licence.qualification_certificate}` : licence.qualification),
  licence.qualification_exemption && `exempt: ${licence.qualification_exemption}`,
].filter(Boolean).join(" · ");

// What a renewal applied for does once the licence is past its date, by its
// kind's rule, with the rule's source (the words before its colon).
export function renewalRuleWords(licence) {
  const source = String(licence.renewal_source || "").replace(/:.*$/, "").trim();
  const cited = source ? ` (${source})` : "";
  if (licence.renewal_rule === "while_pending") return `It stays in force past its date while the renewal is pending${cited}.`;
  if (licence.renewal_rule === "applied_within") {
    const by = licence.renewal_deadline ? `, that is by ${dateShort(licence.renewal_deadline, { year: true })}` : "";
    return `It stays in force past its date only when the renewal was applied for within one month of it${by}${cited}.`;
  }
  return "A renewal applied for does not keep this kind of licence in force after its date.";
}

// A principal certificate's standing on the business's date.
const PRINCIPAL_STATES = {
  valid: { label: "Valid", tone: "success" }, not_yet: { label: "Not yet valid", tone: "info" }, expired: { label: "Run out", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "danger" },
};
export const principalStateOf = (p) => (p.state === "withdrawn" && p.withdrawn_on
  ? { label: `Withdrawn ${dateShort(p.withdrawn_on, { year: true })}`, tone: "danger" }
  : PRINCIPAL_STATES[p.state] || { label: p.state, tone: "neutral" });

// "EC, WP, SC" as the list the server takes: each formulation once, as typed.
export const formulationsOf = (text) => [...new Set(String(text || "").split(",").map((f) => f.trim().replace(/\s+/g, " ")).filter(Boolean))];

// The catalogue's insecticides (pesticide items), one per product (an
// endorsement covers every pack of an item), and the manufacturers they name
// (the item's manufacturer, else its brand), which a principal certificate is matched by.
export function insecticidesOf(skus) {
  const products = new Map();
  const makers = new Set();
  for (const sku of skus || []) {
    if (sku.attributes?.inputKind !== "pesticide") continue;
    const maker = String(sku.attributes.manufacturer || sku.brand || "").trim();
    if (maker) makers.add(maker);
    const known = products.get(sku.product_id);
    if (known) {
      if (sku.code) known.codes.push(sku.code);
      continue;
    }
    products.set(sku.product_id, { product_id: sku.product_id, name: sku.product_name || sku.label, brand: sku.brand || "", maker, codes: sku.code ? [sku.code] : [] });
  }
  return {
    products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name)),
    makers: [...makers].sort((a, b) => a.localeCompare(b)),
  };
}

// --- Scanned copies --------------------------------------------------------------------------------

// A PDF or a photo of the licence, up to 5 MB (the server checks the bytes too).
export const COPY_TYPES = ".pdf,.jpg,.jpeg,.png,.webp";
export const COPY_MAX_BYTES = 5 * 1024 * 1024;
export const fileSize = (bytes) => (Number(bytes) >= 1024 * 1024 ? `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`);
// The dates the licence had when the copy was added.
export const copyDates = (copy) => (copy.valid_until
  ? `${dateShort(copy.valid_from, { year: true })} to ${dateShort(copy.valid_until, { year: true })}`
  : `From ${dateShort(copy.valid_from, { year: true })}, no expiry`);

// A refusal of a file asked for as a blob carries the server's sentence inside the blob.
async function refusal(err) {
  const data = err?.response?.data;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    try {
      const message = JSON.parse(await data.text())?.message;
      if (message) return message;
    } catch {
      // Not the server's JSON: the usual words below.
    }
  }
  return getErrorMessage(err);
}

// Opens a scanned copy in a new tab: private, so it comes through the API.
export async function openLicenceCopy(businessId, licenceId, fileId) {
  try {
    const response = await api.get(`/businesses/${businessId}/licences/${licenceId}/files/${fileId}`, { responseType: "blob" });
    const url = URL.createObjectURL(response.data);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    toast.error(await refusal(err));
  }
}

// Keeps a scanned copy with the licence, with the licence's dates now.
export async function addLicenceCopy(businessId, licenceId, file) {
  const form = new FormData();
  form.append("file", file);
  return (await api.post(`/businesses/${businessId}/licences/${licenceId}/files`, form)).data.data;
}
