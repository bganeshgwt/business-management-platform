import { newKey } from "../../core/pages/hooks";

// What a shift's close sends for its count, its other sales and its big
// fills, as typed on the close (ShiftExtras.jsx draws them); the server works
// out and checks every figure again.

export const countBody = (denominations, count) => denominations.filter((d) => Number(count[d] || 0) > 0).map((d) => ({ denomination: d, pieces: Number(count[d]) }));

export const blankGoods = () => ({ key: newKey(), skuId: "", quantity: "", contactId: "" });

export const blankBigFill = () => ({ key: newKey(), productId: "", litres: "", registration: "", buyerName: "", pan: "", declaration: false, bankMethodId: "", bank: "", cash: "" });

export const bigFillsBody = (fills) => fills.filter((f) => f.productId && f.litres.trim()).map((f) => ({
  productId: f.productId, litres: f.litres.trim(), ...(f.registration.trim() ? { registration: f.registration.trim() } : {}), ...(f.buyerName.trim() ? { buyerName: f.buyerName.trim() } : {}),
  ...(f.declaration ? { panDeclaration: true } : { pan: f.pan.trim() }),
  payments: [...(f.bankMethodId && f.bank.trim() ? [{ methodId: f.bankMethodId, amount: f.bank.trim() }] : []), ...(f.cash.trim() ? [{ method: "cash", amount: f.cash.trim() }] : [])],
}));

// What a closed shift's bills are, in words.
export const BILL_PARTS = { walk_in: "Walk-in fuel", credit: "Fleet fuel on credit", big_fill: "Fill of ₹2,00,000 or more", goods: "Other sales (GST)" };
