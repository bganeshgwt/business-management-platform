import { sectionRule, typeAllows } from "../../../../services/businessNav";

// The screens a business has, for the fields and words that only matter
// with one: the counter's rules (walk-ins, a shared till, a location kept
// for stock only) where it bills at Quick bill, and receipts where its bills
// print on a receipt roll.

// Whether a business has a screen: its type's menu has it and the module it
// needs is on (services/businessNav.js).
export function hasScreen(biz, section) {
  const rule = sectionRule(section, biz.type);
  return Boolean(rule && typeAllows(rule, biz.type) && (!rule.module || biz.has(rule.module)));
}

// Whether its bills print as receipts: at Quick bill, or a salon's New bill.
export const printsReceipts = (biz) => hasScreen(biz, "counter") || hasScreen(biz, "salon-bill");
