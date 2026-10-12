import { newKey } from "../../core/pages/hooks";

// Quick bill's payment helpers (round 2, R2-CORE): split payment parts, an
// EMI's finance details, and the bill carried across a switch of biller.

export const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
export const newPart = (method = "cash", amount = "") => ({ key: newKey(), method, amount, reference: "", tendered: "" });

// What a list of payment parts comes to, and the change (cash only).
export function partsSummary(parts) {
  const paid = round2(parts.reduce((s, p) => s + (Number(p.amount) > 0 ? Number(p.amount) : 0), 0));
  const change = round2(parts.reduce((s, p) => s + (p.method === "cash" && Number(p.tendered) > Number(p.amount) ? Number(p.tendered) - Number(p.amount) : 0), 0));
  const shortCash = parts.some((p) => p.method === "cash" && p.tendered !== "" && Number(p.tendered) < Number(p.amount));
  return { paid, change, shortCash };
}
// The parts as the server takes them (only those with an amount).
export const partsBody = (parts) => parts.filter((p) => Number(p.amount) > 0).map((p) => ({
  method: p.method, amount: Number(p.amount).toFixed(2),
  ...(p.reference.trim() && p.method !== "cash" ? { reference: p.reference.trim() } : {}),
  ...(p.method === "cash" && Number(p.tendered) > Number(p.amount) ? { tendered: Number(p.tendered).toFixed(2) } : {}),
}));

export const emptyFinance = () => ({ financierId: "", loanNo: "", doNo: "", tenure: "", down: [newPart("cash")] });
export function financeReady(value, toPay) {
  const { paid, shortCash } = partsSummary(value.down);
  return Boolean(value.financierId && value.loanNo.trim()) && !shortCash && toPay - paid > 0.004;
}
export const financeBody = (value) => ({
  ...(partsBody(value.down).length ? { payments: partsBody(value.down) } : {}),
  finance: { financierId: Number(value.financierId), loanNo: value.loanNo.trim(), ...(value.doNo.trim() ? { doNo: value.doNo.trim() } : {}),
    ...(Number(value.tenure) > 0 ? { tenureMonths: Number(value.tenure) } : {}), amount: "rest" },
});

// --- The bill carried across a switch of biller ------------------------------------------
// Switching the till to another person starts their own session (the screen
// is drawn again for them); the bill being built goes with it, in this tab only.
const carryKey = (businessId) => `counter-carry-${businessId}`;
export function writeCarry(businessId, bill) {
  try { sessionStorage.setItem(carryKey(businessId), JSON.stringify(bill)); } catch { /* storage blocked: the bill stays with the old session */ }
}
export function takeCarry(businessId) {
  try {
    const text = sessionStorage.getItem(carryKey(businessId));
    sessionStorage.removeItem(carryKey(businessId));
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

