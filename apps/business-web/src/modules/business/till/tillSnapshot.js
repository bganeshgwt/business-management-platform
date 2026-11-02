// What a till keeps of the server's snapshot (GET /businesses/:id/till/snapshot),
// as one plain object the pricing module and the screens read. Kept free of
// the browser so the tests run it as it is.
//
// The server sends items and customers in full only when their stamps differ
// from the ones the till sent; otherwise it says "unchanged" and sends just
// the balances that moved since the till's last snapshot.

// The query a till sends for its next snapshot.
export const snapshotQuery = (kept) => (kept ? { since: kept.serverTime, items: kept.itemsStamp, customers: kept.customersStamp } : {});

// The kept snapshot with the server's answer laid over it.
export function mergeSnapshot(kept, answer, savedAt = Date.now()) {
  const sameItems = Boolean(answer.items?.unchanged && kept);
  const sameCustomers = Boolean(answer.customers?.unchanged && kept);
  const balances = new Map((answer.customers?.balances || []).map((row) => [Number(row.id), row.balance]));
  const people = sameCustomers ? kept.customers : answer.customers?.rows || [];
  return {
    serverTime: answer.serverTime, today: answer.today, savedAt,
    till: answer.till, business: answer.business, settings: answer.settings, seller: answer.seller, location: answer.location,
    units: answer.units || [], methods: answer.methods || [], rules: answer.rules || [], slab: answer.slab || null,
    items: sameItems ? kept.items : answer.items?.rows || [],
    excluded: sameItems ? kept.excluded : answer.items?.excluded || [],
    itemsStamp: answer.items?.stamp || null,
    customers: people.map((person) => (balances.has(Number(person.id)) ? { ...person, balance: balances.get(Number(person.id)) } : person)),
    customersStamp: answer.customers?.stamp || null,
  };
}

const normal = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// A scanned or typed code on the till: an item's barcode, code, ISBN or a
// weighing-scale label ("21" + the item's scale code + grams + a check digit),
// as the counter's own scan reads it. { item, quantity } or { excluded } or null.
export function findCode(snapshot, text) {
  const code = String(text || "").replace(/\s/g, "");
  if (!code) return null;
  const upper = code.toUpperCase();
  const match = (row) => row.barcode === code || String(row.code || "").toUpperCase() === upper || (row.isbn && row.isbn === code);
  const item = snapshot.items.find(match);
  if (item) return { item, quantity: null };
  if (/^21\d{11}$/.test(code)) {
    const plu = code.slice(2, 7);
    const weighed = snapshot.items.find((row) => row.plu === plu);
    const grams = Number(code.slice(7, 12));
    if (weighed && grams && validEan(code)) {
      const unit = (snapshot.units || []).find((u) => u.code === weighed.unit);
      return { item: weighed, quantity: Number(((grams / 1000) / Number(unit?.factor || 1)).toFixed(3)), scale: true };
    }
  }
  const excluded = (snapshot.excluded || []).find(match);
  return excluded ? { excluded } : null;
}

// EAN-13's check digit (a scale label is one).
function validEan(code) {
  const digits = code.split("").map(Number);
  const check = digits.pop();
  const total = digits.reduce((s, d, i) => s + d * (i % 2 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === check;
}

// Items whose name, code or barcode has every word typed.
export function searchItems(snapshot, query, limit = 12) {
  const words = normal(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const item of snapshot.items) {
    const text = normal(`${item.label} ${item.code} ${item.barcode || ""} ${item.productName || ""}`);
    if (words.every((w) => text.includes(w))) hits.push(item);
    if (hits.length >= limit) break;
  }
  return hits;
}

// Customers by name or phone (the last digits of a phone match too).
export function searchCustomers(snapshot, query, limit = 8) {
  const text = normal(query).trim();
  if (!text) return [];
  const digits = text.replace(/\D/g, "");
  return snapshot.customers.filter((c) => normal(c.name).includes(text) || (digits.length >= 3 && String(c.phone || "").replace(/\D/g, "").includes(digits))).slice(0, limit);
}
